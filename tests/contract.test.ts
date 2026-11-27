import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { getClub, insertClub, saveServer, type Club } from '@/lib/clubs'
import { fakeCalls, fakeClubs, fakeFailures } from '@/lib/engine'
import { enqueue, whenIdle } from '@/lib/ops'
import { setLinks } from '@/lib/projects'
import { saveSettings } from '@/lib/settings'
import { freshEnv } from './setup'

// The contract with servers that are already running sites.
//
// Live servers run
// today's clubctl, so every clubctl call the deployer makes, and the settings
// it sends with it, must stay exactly the same through that work. These
// snapshots pin them: a change here is a change to what live servers receive,
// and must be made on purpose (and shipped with a matching clubctl).

let serverId = 0
beforeEach(() => {
  freshEnv()
  fakeClubs().clear(); fakeFailures().clear(); fakeCalls().length = 0
  serverId = saveServer({ name: 'S1', host: '10.0.0.1', port: 22, username: 'deployer', hostKey: 'ssh-ed25519 AAAAtest', publicIp: '10.0.0.1', maxClubs: 5, acceptsNew: true })
  saveSettings({
    baseDomain: 'avro.site', defaultImage: 'ghcr.io/avrotech-com-au/avrosphere-shared:1.5.0',
    smtpHost: 'smtp.example.com', smtpUser: 'u', smtpPass: 'smtp-pass', smtpFromAddress: 'no-reply@example.com',
  })
})

/** Calls with values that differ per run (random keys) masked. */
function calls() {
  return fakeCalls().map((c) => ({
    args: c.args,
    stdin: c.stdin?.replace(/^(ASSIST_KEY|STATS_API_KEY)=.*$/gm, '$1=<per-site key>'),
  }))
}

describe('what live servers receive', () => {
  it('app from a Docker image: create and deploy', async () => {
    const app = insertClub({
      name: 'web', displayName: 'Web', serverId, status: 'creating', image: 'docker.io/library/nginx:1.27', modules: [], customDomains: ['www.example.com'],
      secrets: { appSecretEnv: { API_TOKEN: 'secret-1' } }, extraEnv: 'MODE=prod', timezone: 'Australia/Sydney', memoryMb: 128, ownerEmail: '', ownerName: '', notes: '',
      kind: 'app', appRepo: '', appBranch: '', appPort: 80, appHealthPath: '/health', appImageRef: 'docker.io/library/nginx:1.27',
    })
    enqueue(app, 'create', 'a'); await whenIdle()
    enqueue(getClub(app.id)!, 'deploy', 'a', { image: 'docker.io/library/nginx:1.28' }); await whenIdle()
    expect(calls().map((c) => ({ ...c, stdin: c.stdin?.replace(/@sha256:[a-f0-9]{64}/g, '@sha256:<digest>') }))).toMatchSnapshot()
  })

  it('PostgreSQL service: create', async () => {
    const pg = insertClub({
      name: 'shop-db', displayName: 'Shop DB', serverId, status: 'creating', image: 'postgres:16', modules: [], customDomains: [], secrets: {}, extraEnv: '',
      timezone: 'Australia/Sydney', memoryMb: 256, ownerEmail: '', ownerName: '', notes: '', kind: 'postgres',
    })
    enqueue(pg, 'create', 'a'); await whenIdle()
    expect(calls()).toMatchSnapshot()
  })

  it('S3 storage service: create, buckets, and an app linked to it (new in clubctl, separate lines)', async () => {
    const s3 = insertClub({
      name: 'shop-files', displayName: 'Shop files', serverId, status: 'creating', image: 'docker.io/chainguard/minio:latest', modules: [], customDomains: [], secrets: {}, extraEnv: '',
      timezone: 'Australia/Sydney', memoryMb: 256, ownerEmail: '', ownerName: '', notes: '', kind: 'minio', appPublic: false,
      s3Buckets: [{ name: 'media', public: true, objects: null, bytes: null }],
    })
    enqueue(s3, 'create', 'a'); await whenIdle()
    enqueue(getClub(s3.id)!, 'buckets', 'a', { buckets: [{ name: 'media', public: true }, { name: 'private', public: false }] }); await whenIdle()
    const app = insertClub({
      name: 'web', displayName: 'Web', serverId, status: 'creating', image: 'docker.io/library/nginx:1.27', modules: [], customDomains: [], secrets: {}, extraEnv: '',
      timezone: 'Australia/Sydney', memoryMb: 128, ownerEmail: '', ownerName: '', notes: '', kind: 'app', appRepo: '', appBranch: '', appPort: 80, appHealthPath: '/',
      appImageRef: 'docker.io/library/nginx:1.27', projectId: getClub(s3.id)!.projectId,
    })
    setLinks(app.id, [{ dbId: s3.id, prefix: '', bucket: 'media' }])
    enqueue(app, 'create', 'a'); await whenIdle()
    expect(calls().map((c) => ({ ...c, stdin: c.stdin?.replace(/@sha256:[a-f0-9]{64}/g, '@sha256:<digest>') }))).toMatchSnapshot()
  })
})

describe('names and paths on live servers', () => {
  const agent = (f: string) => fs.readFileSync(path.join(__dirname, '..', 'agent', f), 'utf8')

  it('keeps the folders, container names and labels existing VMs use (the defaults)', () => {
    expect(agent('clubctl')).toContain('[[ -f "$ROOT/agent.conf" ]] || ROOT=/opt/avrosphere')
    expect(agent('clubctl')).toMatch(/^NAMESPACE=avrosphere$/m)
    expect(agent('clubctl')).toMatch(/^SHARED_NET=avrosphere$/m)
    expect(agent('clubctl')).toMatch(/^APPS_NET=avro-apps$/m)
    expect(agent('setup-clubs-vm.sh')).toContain('ROOT="${AGENT_ROOT:-/opt/avrosphere}"')
    expect(agent('setup-clubs-vm.sh')).toContain('NAMESPACE="${AGENT_NAMESPACE:-avrosphere}"')
    expect(agent('files/docker-compose.base.yml')).toContain('${NAMESPACE:-avrosphere}-caddy')
    expect(agent('files/docker-compose.base.yml')).toContain('${NAMESPACE:-avrosphere}-postgres')
    expect(agent('files/docker-compose.base.yml')).toContain('name: ${APPS_NET:-avro-apps}')
    // clubctl-ssh runs the clubctl beside it, so /opt/avrosphere/bin keeps working.
    expect(agent('clubctl-ssh')).toContain('$(dirname "$(readlink -f "$0")")/clubctl')
  })

  it('reads agent.conf without running it', () => {
    expect(agent('clubctl')).not.toMatch(/^\s*(source|\.)\s+.*agent\.conf/m)
  })
})
