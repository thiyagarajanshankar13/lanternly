import { beforeEach, describe, expect, it } from 'vitest'
import { getClub, insertClub, listClubVersions, saveServer, type Club } from '@/lib/clubs'
import { clubDomains } from '@/lib/clubEnv'
import { fakeCalls, fakeClubs, fakeFailures } from '@/lib/engine'
import { enqueue, getOperation, pinnedImage, whenIdle } from '@/lib/ops'
import { appSettingsText, healthPathError, registryText } from '@/lib/apps/config'
import { imageDisplay, parseImageRef, registryUserError } from '@/lib/apps/imageRef'
import { secretValues } from '@/lib/access'
import { saveSettings } from '@/lib/settings'
import { freshEnv } from './setup'

let serverId = 0
const imageApp = (name: string, over: Partial<Club> = {}) => insertClub({
  name, displayName: name, serverId, status: 'creating', image: 'docker.io/library/nginx:1.27', modules: [], customDomains: [], secrets: {}, extraEnv: '',
  timezone: 'Australia/Sydney', memoryMb: 128, ownerEmail: '', ownerName: '', notes: '', kind: 'app', appRepo: '', appBranch: '',
  appPort: 80, appHealthPath: '', appImageRef: 'docker.io/library/nginx:1.27', ...over,
})

beforeEach(() => {
  freshEnv()
  fakeClubs().clear(); fakeFailures().clear(); fakeCalls().length = 0
  serverId = saveServer({ name: 'S1', host: '10.0.0.1', port: 22, username: 'deployer', hostKey: 'ssh-ed25519 AAAAtest', publicIp: '10.0.0.1', maxClubs: 5, acceptsNew: true })
  saveSettings({ baseDomain: 'avro.site', defaultImage: 'img:1' })
})

describe('image names', () => {
  const ok = (input: string) => { const r = parseImageRef(input); if ('error' in r) throw new Error(r.error); return r }
  it('understands the usual ways people write an image', () => {
    expect(ok('nginx')).toMatchObject({ ref: 'docker.io/library/nginx:latest', display: 'nginx:latest', registry: 'docker.io', pinned: false })
    expect(ok('nginx:1.27')).toMatchObject({ ref: 'docker.io/library/nginx:1.27', display: 'nginx:1.27', pinned: true })
    expect(ok(' docker pull Bitnami/Redis:7.4 ')).toMatchObject({ ref: 'docker.io/bitnami/redis:7.4', display: 'bitnami/redis:7.4' })
    expect(ok('ghcr.io/owner/app:v2')).toMatchObject({ ref: 'ghcr.io/owner/app:v2', registry: 'ghcr.io', display: 'ghcr.io/owner/app:v2' })
    expect(ok('localhost:5000/tool')).toMatchObject({ ref: 'localhost:5000/tool:latest', registry: 'localhost:5000' })
    expect(ok('index.docker.io/library/postgres:16')).toMatchObject({ ref: 'docker.io/library/postgres:16' })
    const digest = `sha256:${'a'.repeat(64)}`
    expect(ok(`nginx@${digest}`)).toMatchObject({ ref: `docker.io/library/nginx@${digest}`, pinned: true })
  })

  it('reads hub.docker.com links', () => {
    expect(ok('https://hub.docker.com/_/nginx').ref).toBe('docker.io/library/nginx:latest')
    expect(ok('https://hub.docker.com/_/nginx/tags?name=1.27').ref).toBe('docker.io/library/nginx:1.27')
    expect(ok('https://hub.docker.com/r/louislam/uptime-kuma').ref).toBe('docker.io/louislam/uptime-kuma:latest')
    expect(ok('https://hub.docker.com/layers/library/redis/7.4/images/sha256-abc').ref).toBe('docker.io/library/redis:7.4')
  })

  it('refuses what isn\'t an image', () => {
    for (const bad of ['', 'https://example.com/nginx', 'https://hub.docker.com/search?q=nginx', 'nginx:bad tag', 'ngi nx', 'nginx@sha256:short', 'a/../b', 'nginx; rm -rf /', 'my_image__x//y']) {
      expect('error' in parseImageRef(bad), bad).toBe(true)
    }
    expect(imageDisplay('docker.io/library/nginx:1.27')).toBe('nginx:1.27')
    expect(registryUserError('me@example.com')).toBeNull()
    expect(registryUserError('bad name')).not.toBeNull()
  })
})

describe('settings sent to clubctl', () => {
  it('sends "-" for no health page and the registry sign-in only for pulls', () => {
    expect(healthPathError('')).toBeNull()
    const club = { extraEnv: 'TZ=UTC', secrets: { registryUser: 'me', registryToken: 'tok\n' }, appPort: 6379, appHealthPath: '', memoryMb: 64 }
    expect(appSettingsText(club)).toContain('CLUBCTL_HEALTH_PATH=-\n')
    expect(appSettingsText(club)).not.toContain('tok')
    expect(registryText(club)).toBe('CLUBCTL_REGISTRY_USER=me\nCLUBCTL_REGISTRY_TOKEN=tok\n')
    expect(registryText({ secrets: {} })).toBe('')
  })

  it('reads the pinned digest from clubctl output', () => {
    const d = `docker.io/library/nginx@sha256:${'b'.repeat(64)}`
    expect(pinnedImage(`==> Pulling x\nPinned to ${d}\n==> Starting`)).toBe(d)
    expect(pinnedImage('==> Pulling x\n')).toBe('')
  })
})

describe('image services', () => {
  it('creates without a build, pins the pulled version and can roll back to it', async () => {
    const c = imageApp('cache', { secrets: { registryUser: 'me', registryToken: 'secret-token-1' } })
    enqueue(c, 'create', 'a@x', { image: c.appImageRef })
    await whenIdle()
    const after = getClub(c.id)!
    expect(after.status).toBe('running')
    expect(after.image).toMatch(/^docker\.io\/library\/nginx@sha256:[a-f0-9]{64}$/)
    const create = fakeCalls().find((x) => x.args[0] === 'app-create')!
    expect(create.stdin).toContain('CLUBCTL_REGISTRY_TOKEN=secret-token-1')
    expect(fakeClubs().get('cache')!.registryUser).toBe('me')
    expect(listClubVersions(c.id)[0]).toMatchObject({ image: after.image, note: 'nginx:1.27' })
    expect(secretValues(after)).toContain('secret-token-1') // masked in logs

    // Pull again: same tag, a new digest; then roll back to the first one.
    enqueue(after, 'deploy', 'a@x', { image: after.appImageRef })
    await whenIdle()
    const second = getClub(c.id)!.image
    expect(second).not.toBe(after.image)
    enqueue(getClub(c.id)!, 'deploy', 'a@x', { image: after.image })
    await whenIdle()
    expect(getClub(c.id)!.image).toBe(after.image)
    expect(listClubVersions(c.id).length).toBe(3)
  })

  it('runs with no web address when asked', async () => {
    const c = imageApp('worker', { appPublic: false })
    expect(clubDomains(getClub(c.id)!, 'avro.site')).toEqual([])
    const op = enqueue(c, 'create', 'a@x', { image: c.appImageRef })
    await whenIdle()
    expect(getOperation(op.id)!.status).toBe('done')
    expect(fakeCalls().find((x) => x.args[0] === 'app-create')!.args[3]).toBe('-')
    expect(fakeClubs().get('worker')!.domains).toBe('')
    enqueue(getClub(c.id)!, 'configure', 'a@x')
    await whenIdle()
    expect(fakeCalls().find((x) => x.args[0] === 'configure')!.args[2]).toBe('-')
  })

  it('keeps GitHub builds as they are', async () => {
    const c = imageApp('built', { appImageRef: '', appRepo: 'o/r', appBranch: 'main', image: '' })
    enqueue(c, 'create', 'a@x', { image: 'ghcr.io/o/app-built:0123456789ab' })
    await whenIdle()
    expect(getClub(c.id)!.image).toBe('ghcr.io/o/app-built:0123456789ab')
  })
})
