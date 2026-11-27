import crypto from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/lib/db'
import { getClub, insertClub, listClubVersions, newNameError, saveServer, type Club } from '@/lib/clubs'
import { fakeCalls, fakeClubs, fakeFailures } from '@/lib/engine'
import { enqueue, getOperation, listOperations, whenIdle } from '@/lib/ops'
import { saveSettings } from '@/lib/settings'
import {
  appImage, appSettingsText, branchError, dockerfileError, healthPathError, mergeSecretEnv, parseEnvLines, repoError, shaOfImage,
} from '@/lib/apps/config'
import { appJwt, fakeGitHub, fakePush, github, validSignature } from '@/lib/apps/github'
import { activeBuild, handlePush, listBuilds, pollBuilds, startBuild } from '@/lib/apps/builds'
import { checkUrl } from '@/lib/monitor'
import { POST as webhook } from '@/app/api/github/webhook/route'
import { freshEnv } from './setup'

const REPO = 'example-org/static-site'
const BRANCH = 'campaign-site'

let serverId = 0
function makeApp(name = 'shopfront', over: Partial<Club> = {}): Club {
  return insertClub({
    name, displayName: 'Shopfront', serverId, status: 'creating', image: '', modules: [], customDomains: [],
    secrets: { appSecretEnv: { SMTP_PASS: 'pass-secret-1' } }, extraEnv: 'SITE_NAME=Shopfront\nMAIL_TO=beta@example.com', timezone: 'Australia/Sydney',
    memoryMb: 128, ownerEmail: '', ownerName: '', notes: '',
    kind: 'app', appRepo: REPO, appBranch: BRANCH, appDockerfile: 'Dockerfile', appPort: 3000, appHealthPath: '/health', appAutoDeploy: true, ...over,
  })
}

/** Lets the simulated GitHub finish every build, then runs the queued operations. */
async function settle() {
  await pollBuilds()
  await whenIdle()
}

beforeEach(() => {
  freshEnv()
  fakeClubs().clear(); fakeFailures().clear(); fakeCalls().length = 0
  const f = fakeGitHub(); f.pushes.clear(); f.runs.clear(); f.failNext = false; f.slow = 0
  serverId = saveServer({ name: 'S1', host: '10.0.0.1', port: 22, username: 'deployer', hostKey: 'ssh-ed25519 AAAAtest', publicIp: '10.0.0.1', maxClubs: 5, acceptsNew: true })
  saveSettings({ baseDomain: 'avro.site', defaultImage: 'ghcr.io/avrotech-com-au/avrosphere-shared:1.3.1', githubBuildRepo: 'example-org/deployer', githubOwner: 'example-org' })
})

describe('app settings and checks', () => {
  it('checks repos, branches, paths and settings lines', () => {
    expect(repoError(REPO, 'example-org')).toBeNull()
    expect(repoError('someone-else/thing', 'example-org')).toMatch(/Only repos owned by/)
    expect(repoError('nope', 'example-org')).toMatch(/owner\/name/)
    expect(branchError(BRANCH)).toBeNull()
    expect(branchError('feature/new-home')).toBeNull()
    for (const bad of ['', 'a..b', '/x', 'x/', 'has space', '-x', 'x;rm']) expect(branchError(bad)).not.toBeNull()
    expect(dockerfileError('web/Dockerfile')).toBeNull()
    expect(dockerfileError('../Dockerfile')).not.toBeNull()
    expect(healthPathError('/health')).toBeNull()
    expect(healthPathError('health')).not.toBeNull()
    expect(healthPathError('/x?y=1')).not.toBeNull()
    expect(parseEnvLines('A=1\n# note\n\nB=two words').env).toEqual({ A: '1', B: 'two words' })
    expect(parseEnvLines('PORT=80').error).toMatch(/PORT/)
    expect(parseEnvLines('CLUBCTL_PORT=1').error).toMatch(/can't be set/)
    expect(parseEnvLines('lower=1').error).toMatch(/KEY=value/)
  })

  it('merges secret settings: add, replace, remove with KEY=', () => {
    const merged = mergeSecretEnv({ A: '1', B: '2' }, 'B=22\nC=3\nA=')
    expect(merged.env).toEqual({ B: '22', C: '3' })
    expect(mergeSecretEnv({ A: '1' }, '').env).toEqual({ A: '1' })
  })

  it('gives clubctl the settings, the secrets and its own lines, one per line', () => {
    const text = appSettingsText({ extraEnv: 'SITE_NAME=Shopfront', secrets: { appSecretEnv: { SMTP_PASS: 'p\nq' } }, appPort: 8080, appHealthPath: '/health', memoryMb: 128 })
    expect(text).toBe('SITE_NAME=Shopfront\nSMTP_PASS=p q\nCLUBCTL_MEMORY_MB=128\nCLUBCTL_PORT=8080\nCLUBCTL_HEALTH_PATH=/health\n')
  })

  it('names images by commit, lower-case owner', () => {
    const sha = 'a'.repeat(40)
    expect(appImage('Example-Org/Deployer', 'shopfront', sha)).toBe(`ghcr.io/example-org/app-shopfront:${'a'.repeat(12)}`)
    expect(shaOfImage(`ghcr.io/x/app-y:${'b'.repeat(12)}`)).toBe('b'.repeat(12))
    expect(shaOfImage('ghcr.io/x/avrosphere-shared:1.3.1')).toBe('')
  })

  it('signs GitHub App tokens with RS256 and checks webhook signatures', () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
    const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
    const jwt = appJwt('12345', pem, Date.UTC(2026, 10, 23))
    const [h, p, sig] = jwt.split('.')
    expect(JSON.parse(Buffer.from(p, 'base64url').toString())).toMatchObject({ iss: '12345', exp: expect.any(Number) })
    expect(crypto.createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(sig, 'base64url'))).toBe(true)
    const body = '{"x":1}'
    const good = 'sha256=' + crypto.createHmac('sha256', 'the-webhook-secret-123').update(body).digest('hex')
    expect(validSignature(body, good, 'the-webhook-secret-123')).toBe(true)
    expect(validSignature(body + ' ', good, 'the-webhook-secret-123')).toBe(false)
    expect(validSignature(body, null, 'the-webhook-secret-123')).toBe(false)
    expect(validSignature(body, good, '')).toBe(false)
  })
})

describe('building and deploying apps', () => {
  it('creates an app: build on GitHub, then app-create with its settings; secrets never stored in the clear', async () => {
    const club = makeApp()
    const build = await startBuild(club, { by: 'admin@x', reason: 'create' })
    expect('status' in build && build.status).toBe('building')
    expect(activeBuild(club.id)).not.toBeNull()
    await settle()
    const after = getClub(club.id)!
    expect(after.status).toBe('running')
    const head = await github().branchHead(REPO, BRANCH)
    expect(after.image).toBe(appImage('example-org/deployer', 'shopfront', head.sha))
    const call = fakeCalls().find((c) => c.args[0] === 'app-create')!
    expect(call.args).toEqual(['app-create', 'shopfront', after.image, 'shopfront.avro.site'])
    expect(call.stdin).toContain('SMTP_PASS=pass-secret-1')
    expect(call.stdin).toContain('CLUBCTL_HEALTH_PATH=/health')
    expect(listClubVersions(club.id)[0]).toMatchObject({ image: after.image, note: `Latest work on ${BRANCH}` })
    const dump = JSON.stringify(db().prepare('SELECT * FROM clubs').all()) + JSON.stringify(db().prepare('SELECT * FROM operations').all())
    expect(dump).not.toContain('pass-secret-1')
  })

  it('waits for a slow build, and marks a failed first build as a failed site', async () => {
    fakeGitHub().slow = 2
    const club = makeApp()
    await startBuild(club, { by: 'a', reason: 'create' })
    await pollBuilds(); await pollBuilds()
    expect(getClub(club.id)!.status).toBe('creating')
    await settle()
    expect(getClub(club.id)!.status).toBe('running')

    fakeGitHub().slow = 0
    fakeGitHub().failNext = true
    const other = makeApp('broken-app')
    await startBuild(other, { by: 'a', reason: 'create' })
    await settle()
    expect(getClub(other.id)!.status).toBe('failed')
    expect(listBuilds(other.id)[0]).toMatchObject({ status: 'failed', error: expect.stringMatching(/GitHub log/) })
    expect(fakeCalls().some((c) => c.args[0] === 'app-create' && c.args[1] === 'broken-app')).toBe(false)
  })

  it('gives up when GitHub never starts the run', async () => {
    const club = makeApp()
    const b = await startBuild(club, { by: 'a', reason: 'create' })
    if (!('id' in b)) throw new Error('expected a build')
    db().prepare('UPDATE app_builds SET run_id = NULL WHERE id = ?').run(b.id)
    fakeGitHub().runs.clear()
    await pollBuilds(Date.now() + 6 * 60_000)
    expect(listBuilds(club.id)[0].status).toBe('failed')
    expect(getClub(club.id)!.status).toBe('failed')
  })

  it('a push to the branch builds and deploys; other branches, repos and switched-off apps are left alone', async () => {
    const club = makeApp()
    await startBuild(club, { by: 'a', reason: 'create' }); await settle()
    const first = getClub(club.id)!.image
    const quiet = makeApp('quiet', { appAutoDeploy: false })
    await startBuild(quiet, { by: 'a', reason: 'create' }); await settle()

    const sha = fakePush(REPO, BRANCH)
    expect(await handlePush({ ref: `refs/heads/${BRANCH}`, after: sha, repository: { full_name: REPO }, head_commit: { message: 'New FAQ\n\nmore' }, pusher: { name: 'sam' } })).toEqual(['shopfront'])
    expect(await handlePush({ ref: 'refs/heads/main', after: sha, repository: { full_name: REPO } })).toEqual([])
    expect(await handlePush({ ref: `refs/heads/${BRANCH}`, after: sha, repository: { full_name: 'example-org/other' } })).toEqual([])
    expect(await handlePush({ ref: `refs/heads/${BRANCH}`, after: sha, deleted: true, repository: { full_name: REPO } })).toEqual([])
    await settle()
    const now = getClub(club.id)!
    expect(now.image).not.toBe(first)
    expect(shaOfImage(now.image)).toBe(sha.slice(0, 12))
    expect(listClubVersions(club.id)[0]).toMatchObject({ note: 'New FAQ', by: 'GitHub push by sam' })
    expect(fakeCalls().filter((c) => c.args[0] === 'app-deploy').map((c) => c.args[1])).toEqual(['shopfront'])

    // The same commit again (a re-sent notice) deploys the built image without a second build.
    const builds = listBuilds(club.id).length
    await handlePush({ ref: `refs/heads/${BRANCH}`, after: sha, repository: { full_name: REPO } })
    await whenIdle()
    expect(listBuilds(club.id).length).toBe(builds)
  })

  it('rolls back to an earlier version without building, and a failed deploy keeps the old one', async () => {
    const club = makeApp()
    await startBuild(club, { by: 'a', reason: 'create' }); await settle()
    const first = getClub(club.id)!.image
    fakePush(REPO, BRANCH)
    await startBuild(getClub(club.id)!, { by: 'a', reason: 'deploy' }); await settle()
    const second = getClub(club.id)!.image
    expect(second).not.toBe(first)

    enqueue(getClub(club.id)!, 'deploy', 'a', { image: first }); await whenIdle()
    expect(getClub(club.id)!.image).toBe(first)
    expect(listClubVersions(club.id)[0]).toMatchObject({ image: first, note: `Latest work on ${BRANCH}` })

    fakeFailures().add('app-deploy')
    const op = enqueue(getClub(club.id)!, 'deploy', 'a', { image: second }); await whenIdle()
    expect(getOperation(op.id)!.status).toBe('failed')
    expect(getClub(club.id)!.image).toBe(first)
  })

  it('apps take settings, pause, resume and removal, but no backups or upgrades', async () => {
    const club = makeApp()
    await startBuild(club, { by: 'a', reason: 'create' }); await settle()
    enqueue(getClub(club.id)!, 'configure', 'a'); await whenIdle()
    expect(fakeCalls().at(-1)!.args).toEqual(['configure', 'shopfront', 'shopfront.avro.site'])
    enqueue(getClub(club.id)!, 'pause', 'a'); await whenIdle()
    expect(getClub(club.id)!.status).toBe('paused')
    enqueue(getClub(club.id)!, 'resume', 'a'); await whenIdle()
    expect(getClub(club.id)!.status).toBe('running')
    const backup = enqueue(getClub(club.id)!, 'backup', 'a'); await whenIdle()
    expect(getOperation(backup.id)!.status).toBe('failed')
    expect(getOperation(backup.id)!.log).toMatch(/isn't something an app does/)
    enqueue(getClub(club.id)!, 'remove', 'a'); await whenIdle()
    expect(getClub(club.id)).toBeNull()
    expect(listOperations({ limit: 50 }).some((o) => o.kind === 'remove' && o.status === 'done')).toBe(true)
  })

  it('backup schedules leave apps alone', async () => {
    const club = makeApp()
    await startBuild(club, { by: 'a', reason: 'create' }); await settle()
    expect(getClub(club.id)!.backupDaily).toBe(false)
  })
})

describe('the webhook', () => {
  const secret = 'webhook-secret-0123456789'
  const send = (body: string, sig: string | null, event = 'push') => webhook(new Request('http://x/api/github/webhook', {
    method: 'POST', body, headers: { 'x-github-event': event, ...(sig ? { 'x-hub-signature-256': sig } : {}) },
  }))
  const sign = (body: string) => 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex')

  it('is off without a secret, refuses bad signatures and deploys on a signed push', async () => {
    expect((await send('{}', null)).status).toBe(404)
    saveSettings({ githubWebhookSecret: secret })
    expect((await send('{}', 'sha256=00')).status).toBe(401)
    expect((await send('{}', sign('{}'), 'ping')).status).toBe(200)
    const club = makeApp()
    await startBuild(club, { by: 'a', reason: 'create' }); await settle()
    const sha = fakePush(REPO, BRANCH)
    const body = JSON.stringify({ ref: `refs/heads/${BRANCH}`, after: sha, repository: { full_name: REPO }, head_commit: { message: 'Fix typo' } })
    const res = await send(body, sign(body))
    expect(res.status).toBe(202)
    expect(await res.json()).toMatchObject({ deploying: ['shopfront'] })
    await settle()
    expect(shaOfImage(getClub(club.id)!.image)).toBe(sha.slice(0, 12))
  })
})

describe('monitoring an app', () => {
  let server: http.Server
  afterAll(() => server?.close())
  it('asks the app\'s own health page', async () => {
    process.env.DEPLOYER_MONITOR_ALLOW_PRIVATE = '1'
    let healthy = true
    server = http.createServer((req, res) => {
      if (req.url === '/health') { res.writeHead(healthy ? 200 : 503); res.end(healthy ? 'ok' : 'no'); return }
      res.writeHead(404); res.end()
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    expect((await checkUrl(origin, '/health')).ok).toBe(true)
    healthy = false
    const down = await checkUrl(origin, '/health')
    expect(down.ok).toBe(false)
    expect(down.error).toMatch(/503/)
  })
})

describe('new service names', () => {
  it('says why a name is refused and suggests a free one', () => {
    expect(newNameError('fresh-site')).toBeNull()
    makeApp()
    expect(newNameError('shopfront')).toBe('"shopfront" is already used by Shopfront (shopfront). Try shopfront-site instead.')
    makeApp('shopfront-site', { displayName: 'shopfront-site' })
    expect(newNameError('shopfront-site')).toBe('"shopfront-site" is already used by shopfront-site. Try shopfront-site-site instead.')
    expect(newNameError('avrosphere')).toBeNull()
    // Settings can reserve more names (Avrotech's install reserves avro, avrotech, avrosphere).
    saveSettings({ extraReservedNames: 'avro avrotech avrosphere' })
    expect(newNameError('avrosphere')).toMatch(/kept for the platform.*Try avrosphere-site instead\.$/)
    expect(newNameError('app')).toMatch(/Try app-site instead/)
    // Names that only contain a reserved word are fine.
    expect(newNameError('avrosphere-site')).toBeNull()
    expect(newNameError('my-app')).toBeNull()
    expect(newNameError('Bad Name')).not.toMatch(/Try/)
  })
})
