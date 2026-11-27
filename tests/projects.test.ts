import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { MIGRATIONS, db, dataDir, resetDbForTests } from '@/lib/db'
import { type Access, canBuildInProject, canSeeProject, canSeeSite, canUsePage } from '@/lib/access'
import { getClub, insertClub, memoryUsed, saveServer, serverRoomError, getServer, updateClub, clubCount, type Club } from '@/lib/clubs'
import { fakeCalls, fakeClubs, fakeFailures } from '@/lib/engine'
import { enqueue, getOperation, listOperations, syncProjectNetworks, whenIdle } from '@/lib/ops'
import {
  createProjectRow, deleteProject, freeProjectName, getProject, getProjectByName, linksClash, pgTuning, pgVarsShown, predeployError,
  prefixError, quotaLevel, referencedDatabases, refsError, serviceIds, setLinks,
} from '@/lib/projects'
import { appsUsing, serviceLines, servicesOf } from '@/lib/services'
import { checkDatabase, createDatabase, databaseError, setDatabaseAlertSenderForTests } from '@/lib/postgres/service'
import { allocate, allocateProjects } from '@/plugins/aws/costs/report'
import { saveSettings } from '@/lib/settings'
import { freshEnv } from './setup'

let serverId = 0
const site = (name: string, over: Partial<Club> & { projectId?: number } = {}) => insertClub({
  name, displayName: name, serverId, status: 'running', image: 'img:1', modules: [], customDomains: [], secrets: {}, extraEnv: '',
  timezone: 'Australia/Sydney', memoryMb: 700, ownerEmail: 'o@example.com', ownerName: 'O', notes: '', ...over,
})
const app = (name: string, projectId: number, over: Partial<Club> = {}) => insertClub({
  name, displayName: name, serverId, status: 'running', image: 'ghcr.io/x/app:1', modules: [], customDomains: [], secrets: {}, extraEnv: '',
  timezone: 'Australia/Sydney', memoryMb: 256, ownerEmail: '', ownerName: '', notes: '', kind: 'app', appRepo: 'o/r', appBranch: 'main',
  appPort: 3000, appHealthPath: '/', projectId, ...over,
})

beforeEach(() => {
  freshEnv()
  fakeClubs().clear(); fakeFailures().clear(); fakeCalls().length = 0
  serverId = saveServer({ name: 'S1', host: '10.0.0.1', port: 22, username: 'deployer', hostKey: 'ssh-ed25519 AAAAtest', publicIp: '10.0.0.1', maxClubs: 5, acceptsNew: true })
  saveSettings({ baseDomain: 'avro.site', defaultImage: 'img:1' })
})

describe('moving to projects', () => {
  it('gives every existing site its own project, named like it', () => {
    resetDbForTests()
    const file = path.join(dataDir(), 'deployer.sqlite')
    fs.rmSync(file, { force: true })
    const old = new Database(file)
    for (let i = 0; i < 10; i++) { old.exec(MIGRATIONS[i]); old.pragma(`user_version = ${i + 1}`) }
    old.prepare("INSERT INTO servers (name, host, port, username, host_key, public_ip, max_clubs, accepts_new, created_at) VALUES ('S1', 'h', 22, 'd', 'k', '', 5, 1, 'x')").run()
    for (const n of ['riverside', 'vote4mates']) {
      old.prepare("INSERT INTO clubs (name, display_name, server_id, status, image, modules, custom_domains, secrets_enc, extra_env, timezone, memory_mb, owner_email, owner_name, notes, created_at, updated_at) VALUES (?, ?, 1, 'running', 'img', '[]', '[]', '', '', '', 700, '', '', '', 'x', 'x')").run(n, n.toUpperCase())
    }
    old.close()
    const rows = db().prepare('SELECT c.name, p.name AS project, p.display_name FROM clubs c JOIN projects p ON p.id = c.project_id ORDER BY c.name').all()
    expect(rows).toEqual([
      { name: 'riverside', project: 'riverside', display_name: 'RIVERSIDE' },
      { name: 'vote4mates', project: 'vote4mates', display_name: 'VOTE4MATES' },
    ])
  })

  it('makes a project for a new site, with a free name', () => {
    createProjectRow({ name: 'riverside', displayName: 'Taken', serverId })
    const c = site('riverside-tt')
    expect(getProject(c.projectId)!.name).toBe('riverside-tt')
    expect(freeProjectName('riverside')).toBe('riverside-2')
    const d = site('riverside', { projectId: undefined })
    expect(getProject(d.projectId)!.name).toBe('riverside-2')
  })

  it('removes only empty projects', () => {
    const c = site('alpha')
    expect(deleteProject(c.projectId)).toMatch(/Remove or move/)
    const empty = createProjectRow({ name: 'empty', displayName: 'Empty', serverId })
    expect(deleteProject(empty)).toBeNull()
    expect(getProjectByName('empty')).toBeNull()
  })
})

describe('project access', () => {
  it('sees a project through the project or one of its services; builds only as operator of the project', () => {
    const viewer: Access = { role: 'viewer', allSites: false, siteIds: [7], projectIds: [3] }
    const operator: Access = { role: 'operator', allSites: false, siteIds: [7], projectIds: [3], projectSiteIds: [11] }
    expect(canSeeProject(viewer, 3)).toBe(true)
    expect(canSeeProject(viewer, 4, [7])).toBe(true)
    expect(canSeeProject(viewer, 4, [8])).toBe(false)
    expect(canBuildInProject(viewer, 3)).toBe(false)
    expect(canBuildInProject(operator, 3)).toBe(true)
    expect(canBuildInProject(operator, 4)).toBe(false)
    expect(canSeeSite(operator, 11)).toBe(true) // a service of one of their projects
    expect(canUsePage(viewer, '/admin/projects')).toBe(true)
  })
})

describe('links and references', () => {
  it('checks prefixes, clashes, references and pre-deploy commands', () => {
    expect(prefixError('')).toBeNull()
    expect(prefixError('ANALYTICS_')).toBeNull()
    expect(prefixError('analytics_')).not.toBeNull()
    expect(prefixError('ANALYTICS')).not.toBeNull()
    expect(linksClash([{ prefix: '' }, { prefix: 'A_' }])).toBeNull()
    expect(linksClash([{ prefix: '' }, { prefix: '' }])).toMatch(/no prefix/)
    expect(refsError('URL=${{shop-db.DATABASE_URL}}', ['shop-db'])).toBeNull()
    expect(refsError('URL=${{ shop-db.PGHOST }}', ['shop-db'])).toBeNull()
    expect(refsError('URL=${{other.DATABASE_URL}}', ['shop-db'])).toMatch(/no database called other/)
    expect(refsError('URL=${{shop-db.NOPE}}', ['shop-db'])).toMatch(/a database has/)
    expect(refsError('URL=${{broken', ['shop-db'])).toMatch(/looks like/)
    expect(referencedDatabases('A=${{a-db.PGHOST}}\nB=${{a-db.PGUSER}}\nC=${{b-db.PGPORT}}')).toEqual(['a-db', 'b-db'])
    expect(predeployError('npm run migrate && npm run seed')).toBeNull()
    expect(predeployError('a\nb')).toMatch(/one line/)
    expect(predeployError('x'.repeat(501))).toMatch(/500/)
  })

  it('shows the variables without the password', () => {
    const vars = pgVarsShown('shop-db', 'A_')
    expect(vars.map((v) => v.key)).toEqual(['A_DATABASE_URL', 'A_PGHOST', 'A_PGPORT', 'A_PGUSER', 'A_PGPASSWORD', 'A_PGDATABASE'])
    expect(vars[0].value).toBe('postgresql://shop_db:••••@shop-db:5432/shop_db')
  })

  it('sizes Postgres to its memory and works out quota levels', () => {
    expect(pgTuning(256)).toEqual({ sharedBuffersMb: 64, maxConnections: 42 })
    expect(pgTuning(64)).toEqual({ sharedBuffersMb: 16, maxConnections: 20 })
    expect(pgTuning(4096).maxConnections).toBe(200)
    expect(quotaLevel(null, 100)).toBe(0)
    expect(quotaLevel(79 * 1024 * 1024, 100)).toBe(0)
    expect(quotaLevel(80 * 1024 * 1024, 100)).toBe(80)
    expect(quotaLevel(100 * 1024 * 1024, 100)).toBe(100)
  })

  it('tells clubctl the project, the links in the same project and the pre-deploy command', () => {
    const shop = site('shop')
    const project = getProject(shop.projectId)!
    const made = createDatabase(project, { name: 'shop-db' }, 'a@x')
    if ('error' in made) throw new Error(made.error)
    const other = createProjectRow({ name: 'other', displayName: 'Other', serverId })
    const stray = createDatabase(getProject(other)!, { name: 'stray-db' }, 'a@x')
    if ('error' in stray) throw new Error(stray.error)
    const web = app('shop-web', project.id, { appPredeploy: 'npm run migrate', extraEnv: 'REPORTS=${{shop-db.PGHOST}}' })
    setLinks(web.id, [{ dbId: made.club.id, prefix: '' }, { dbId: stray.club.id, prefix: 'X_' }])
    const lines = serviceLines(getClub(web.id)!)
    expect(lines).toContain('CLUBCTL_PROJECT=shop')
    expect(lines).toContain('CLUBCTL_LINK=shop-db:')
    expect(lines.some((l) => l.includes('stray-db'))).toBe(false) // another project's database never links
    expect(lines).toContain(`CLUBCTL_PREDEPLOY_B64=${Buffer.from('npm run migrate').toString('base64')}`)
    expect(appsUsing(made.club.id).map((a) => a.name)).toEqual(['shop-web'])
    expect(servicesOf(project.id).map((c) => c.kind)).toEqual(['avrosphere', 'app', 'postgres'])
  })
})

describe('databases', () => {
  it('checks names, versions and sizes, and keeps them off the site places', () => {
    site('taken')
    expect(databaseError({ name: 'taken' })).toMatch(/already used by taken. Try taken-/)
    expect(databaseError({ name: 'Bad Name' })).toMatch(/Name/)
    expect(databaseError({ name: 'ok-db', version: '9' })).toMatch(/PostgreSQL/)
    expect(databaseError({ name: 'ok-db', memoryMb: 32 })).toMatch(/Memory/)
    expect(databaseError({ name: 'ok-db', quotaMb: 10 })).toMatch(/quota/)
    const c = site('host')
    createDatabase(getProject(c.projectId)!, { name: 'host-db' }, 'a@x')
    expect(clubCount(serverId)).toBe(2)
    expect(memoryUsed(serverId)).toBe(700 + 700 + 256)
  })

  it('refuses a service when the server has no memory left', () => {
    saveServer({ id: serverId, name: 'S1', host: '10.0.0.1', port: 22, username: 'deployer', hostKey: 'ssh-ed25519 AAAAtest', publicIp: '10.0.0.1', maxClubs: 5, acceptsNew: true, memoryMb: 2048 })
    const c = site('full') // 700 of 1024 left
    expect(serverRoomError(getServer(serverId)!, { memoryMb: 256, site: false })).toBeNull()
    expect(serverRoomError(getServer(serverId)!, { memoryMb: 512, site: false })).toMatch(/324 MB of memory left/)
    const r = createDatabase(getProject(c.projectId)!, { name: 'full-db', memoryMb: 512 }, 'a@x')
    expect('error' in r && r.error).toMatch(/memory left/)
  })

  it('creates a database in its project, links an app and restarts it on a new password', async () => {
    const c = site('club')
    enqueue(getClub(c.id)!, 'create', 'a@x', { adminEmail: 'o@example.com', adminPassword: 'Secret-Pass-1' })
    const project = getProject(c.projectId)!
    const made = createDatabase(project, { name: 'club-db', version: '17', memoryMb: 512 }, 'a@x')
    if ('error' in made) throw new Error(made.error)
    await whenIdle()
    expect(getClub(made.club.id)!.status).toBe('running')
    const call = fakeCalls().find((x) => x.args[0] === 'db-create')!
    expect(call.args).toEqual(['db-create', 'club-db', 'postgres:17'])
    expect(call.stdin).toContain('CLUBCTL_MEMORY_MB=512')
    expect(call.stdin).toContain('CLUBCTL_PROJECT=club')
    expect(fakeClubs().get('club-db')!.project).toBe('club')
    expect(getClub(made.club.id)!.backupDaily).toBe(true) // backed up like a site

    const web = app('club-web', project.id, { status: 'running' })
    setLinks(web.id, [{ dbId: made.club.id, prefix: '' }])
    enqueue(getClub(made.club.id)!, 'rotate', 'a@x')
    await whenIdle()
    expect(fakeCalls().some((x) => x.args[0] === 'db-rotate')).toBe(true)
    const restart = listOperations({ clubId: web.id })[0]
    expect(restart.kind).toBe('configure')
    expect(restart.createdBy).toBe('a@x')
  })

  it('emails at 80% and 100%, goes read-only when full and back when there is room', async () => {
    const sent: string[] = []
    setDatabaseAlertSenderForTests((subject) => { sent.push(subject) })
    const c = site('quota')
    const made = createDatabase(getProject(c.projectId)!, { name: 'quota-db', quotaMb: 256 }, 'a@x')
    if ('error' in made) throw new Error(made.error)
    await whenIdle()
    const fake = fakeClubs().get('quota-db')!
    fake.db = Buffer.alloc(210 * 1024 * 1024)
    await checkDatabase(getClub(made.club.id)!)
    expect(sent).toEqual(['Database 80% full: quota-db'])
    expect(getClub(made.club.id)!.pgSizeBytes).toBe(210 * 1024 * 1024)
    fake.db = Buffer.alloc(257 * 1024 * 1024)
    await checkDatabase(getClub(made.club.id)!)
    expect(sent[1]).toBe('Database full: quota-db')
    expect(getClub(made.club.id)!.pgReadOnly).toBe(true)
    expect(fake.readOnly).toBe(true)
    await checkDatabase(getClub(made.club.id)!) // no second email
    expect(sent).toHaveLength(2)
    updateClub(made.club.id, { pgQuotaMb: 1024 })
    await checkDatabase(getClub(made.club.id)!)
    expect(getClub(made.club.id)!.pgReadOnly).toBe(false)
    expect(sent[2]).toBe('Database taking writes again: quota-db')
    setDatabaseAlertSenderForTests(undefined)
  })

  it('upgrades the version and keeps the old one when it fails', async () => {
    const c = site('up')
    const made = createDatabase(getProject(c.projectId)!, { name: 'up-db' }, 'a@x')
    if ('error' in made) throw new Error(made.error)
    await whenIdle()
    fakeFailures().add('db-upgrade')
    const bad = enqueue(getClub(made.club.id)!, 'upgrade', 'a@x', { image: 'postgres:17' })
    await whenIdle()
    expect(getOperation(bad.id)!.status).toBe('failed')
    expect(getClub(made.club.id)!.image).toBe('postgres:16')
    enqueue(getClub(made.club.id)!, 'upgrade', 'a@x', { image: 'postgres:17' })
    await whenIdle()
    expect(getClub(made.club.id)!.image).toBe('postgres:17')
  })

  it('passes the pre-deploy command and links when an app is created, and stops on a failed pre-deploy', async () => {
    const c = site('pd')
    const project = getProject(c.projectId)!
    const made = createDatabase(project, { name: 'pd-db' }, 'a@x')
    if ('error' in made) throw new Error(made.error)
    const web = app('pd-web', project.id, { status: 'creating', appPredeploy: 'npm run migrate' })
    setLinks(web.id, [{ dbId: made.club.id, prefix: '' }])
    await whenIdle()
    enqueue(getClub(web.id)!, 'create', 'a@x', { image: 'ghcr.io/x/app:2' })
    await whenIdle()
    const fake = fakeClubs().get('pd-web')!
    expect(fake.project).toBe('pd')
    expect(fake.links).toEqual(['pd-db:'])
    expect(fake.predeploy).toBe('npm run migrate')

    fakeFailures().add('predeploy')
    const op = enqueue(getClub(web.id)!, 'deploy', 'a@x', { image: 'ghcr.io/x/app:3' })
    await whenIdle()
    expect(getOperation(op.id)!.status).toBe('failed')
    expect(getOperation(op.id)!.log).toMatch(/pre-deploy/i)
  })

  it('moves services onto their project network, and waits for an old clubctl', async () => {
    const holder = site('net-holder')
    updateClub(holder.id, { projectSynced: 1 })
    const made = createDatabase(getProject(holder.projectId)!, { name: 'net' }, 'a@x')
    if ('error' in made) throw new Error(made.error)
    await whenIdle()
    const c = getClub(made.club.id)!
    updateClub(c.id, { projectSynced: 0 })
    expect(syncProjectNetworks('a@x')).toBe(1)
    await whenIdle()
    expect(fakeCalls().map((x) => x.args.join(' '))).toContain('project-set net net-holder')
    expect(getClub(c.id)!.projectSynced).toBe(1)
    expect(syncProjectNetworks('a@x')).toBe(0)
    expect(serviceIds(c.projectId).sort()).toEqual([holder.id, c.id].sort())
  })
})

describe('costs per project', () => {
  it('adds up its services and splits the shared VMs per project', () => {
    const sites = [
      { id: 1, name: 'a', displayName: 'A', serverId: 1, memoryMb: 700, running: true, bucketBytes: 100 },
      { id: 2, name: 'a-db', displayName: 'A db', serverId: 1, memoryMb: 300, running: true, bucketBytes: 100 },
      { id: 3, name: 'b', displayName: 'B', serverId: 1, memoryMb: 1000, running: true, bucketBytes: 0 },
    ]
    const resources = [
      { kind: 'instance', name: 'sites', plan: 'x', monthlyUsd: 20, publicIp: '1.1.1.1', privateIp: '', state: 'running' },
      { kind: 'instance', name: 'deployer', plan: 'x', monthlyUsd: 10, publicIp: '2.2.2.2', privateIp: '', state: 'running' },
      { kind: 'bucket', name: 'b', plan: 'x', monthlyUsd: 1, publicIp: '', privateIp: '', state: '' },
    ] as Parameters<typeof allocate>[2]
    const alloc = allocate(sites, [{ id: 1, name: 'S1', host: 'h', publicIp: '1.1.1.1' }], resources, 1.5)
    const projects = allocateProjects(alloc, [{ id: 10, name: 'Proj A' }, { id: 20, name: 'Proj B' }, { id: 30, name: 'Empty' }], (id) => (id === 3 ? 20 : 10), new Set([1, 2, 3]), 1.5)
    expect(projects.map((p) => p.name)).toEqual(['Proj A', 'Proj B'])
    const a = projects.find((p) => p.id === 10)!
    expect(a.services).toBe(2)
    expect(a.vm).toBe(15) // half the sites VM (1000 of 2000 MB) × 1.5
    expect(a.bucket).toBe(1.5)
    expect(a.shared).toBe(7.5) // the deployer split between two projects, not three services
    expect(projects.find((p) => p.id === 20)!.total).toBe(22.5)
  })
})
