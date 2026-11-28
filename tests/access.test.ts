import fs from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  type Access, accessChip, accessSummary, canOperateSite, canSeeSite, canUsePage, homePage, lastOwnerError, maskSecrets, pagesFor, secretValues, visibleTo,
} from '@/lib/access'
import { acceptInvite, checkPassword, createAdmin, findInvite, getAdmin, inviteAdmin, ownerCount, ownerEmails, renewInvite, setAccess, setSuspended } from '@/lib/auth'
import { audit, auditView, listAudit } from '@/lib/audit'
import { insertClub, saveServer } from '@/lib/clubs'
import { db } from '@/lib/db'
import { maskedLog } from '@/lib/logs'
import { freshEnv } from './setup'

freshEnv()

const owner: Access = { role: 'owner', allSites: true, siteIds: [] }
const viewer: Access = { role: 'viewer', allSites: false, siteIds: [2] }
const operator: Access = { role: 'operator', allSites: false, siteIds: [2, 3] }
const allViewer: Access = { role: 'viewer', allSites: true, siteIds: [] }

describe('access rules', () => {
  it('owners reach everything, others only their sites', () => {
    expect(canSeeSite(owner, 99)).toBe(true)
    expect(canSeeSite(owner, null)).toBe(true)
    expect(canSeeSite(viewer, 2)).toBe(true)
    expect(canSeeSite(viewer, 3)).toBe(false)
    expect(canSeeSite(viewer, null)).toBe(false) // outside sites, removed sites
    expect(canSeeSite(allViewer, 12345)).toBe(true)
  })
  it('viewers never operate; operators only on their list', () => {
    expect(canOperateSite(viewer, 2)).toBe(false)
    expect(canOperateSite(allViewer, 2)).toBe(false)
    expect(canOperateSite(operator, 3)).toBe(true)
    expect(canOperateSite(operator, 4)).toBe(false)
    expect(canOperateSite(owner, 4)).toBe(true)
  })
  it('filters lists and the side menu', () => {
    const rows = [{ id: 1 }, { id: 2 }, { id: 3 }]
    expect(visibleTo(viewer, rows, (r) => r.id).map((r) => r.id)).toEqual([2])
    expect(visibleTo(owner, rows, (r) => r.id)).toHaveLength(3)
    expect(pagesFor(viewer)).toEqual(['/admin/projects', '/admin/services', '/admin/monitor', '/admin/activity', '/admin/account'])
    // Signing in and /admin land on Projects, for every role.
    expect(homePage(viewer)).toBe('/admin/projects')
    expect(homePage(owner)).toBe('/admin/projects')
    for (const page of ['/admin/costs', '/admin/servers', '/admin/settings', '/admin/people', '/admin/backups', '/admin/assistant']) {
      expect(canUsePage(operator, page)).toBe(false)
      expect(canUsePage(owner, page)).toBe(true)
    }
  })
  it('describes access in plain words', () => {
    expect(accessChip(viewer)).toBe('Viewer · 1 site')
    expect(accessChip(allViewer)).toBe('Viewer · all sites')
    const names = new Map([[2, 'Shopfront'], [3, 'Riverside TT']])
    expect(accessSummary(viewer, (id) => names.get(id))).toBe("Can read the status, monitoring and logs of Shopfront. Can't change anything.")
    expect(accessSummary(operator, (id) => names.get(id))).toContain('Shopfront and Riverside TT')
  })
  it('never leaves the deployer without an owner', () => {
    const lastOwner = { role: 'owner' as const }
    expect(lastOwnerError(1, lastOwner, { role: 'viewer' })).toMatch(/at least one owner/)
    expect(lastOwnerError(1, lastOwner, { suspended: true })).toMatch(/at least one owner/)
    expect(lastOwnerError(1, lastOwner, { removed: true })).toMatch(/at least one owner/)
    expect(lastOwnerError(2, lastOwner, { removed: true })).toBeNull()
    expect(lastOwnerError(1, { role: 'viewer' }, { removed: true })).toBeNull()
  })
})

describe('masking secrets in logs', () => {
  const club = {
    secrets: { squareAccessToken: 'EAAAsq-token-123456', appSecretEnv: { SMTP_PASS: 'hunter2hunter2' } },
    extraEnv: 'NODE_ENV=production\nSTRIPE_KEY=sk_live_abcdef123\nSHORT_KEY=abc\n# OLD_TOKEN=notreally',
  }
  it('collects the site secrets and secret-looking env values', () => {
    const values = secretValues(club)
    expect(values).toEqual(expect.arrayContaining(['EAAAsq-token-123456', 'hunter2hunter2', 'sk_live_abcdef123']))
    expect(values).not.toContain('production')
    expect(values).not.toContain('abc') // too short to mask safely
    expect(values).not.toContain('notreally') // commented out
  })
  it('blanks them out, plus anything after a password-ish name', () => {
    const log = 'boot with EAAAsq-token-123456\nsmtp login hunter2hunter2 ok\nDATABASE_PASSWORD=pg-secret-value\nnode production ready'
    const out = maskedLog(log, club)
    expect(out).not.toContain('EAAAsq-token-123456')
    expect(out).not.toContain('hunter2hunter2')
    expect(out).not.toContain('pg-secret-value')
    expect(out).toContain('node production ready')
    expect(maskSecrets('api_key: "abcdef12345"', [])).toBe('api_key: "••••"')
  })
})

describe('people', () => {
  let siteA = 0, siteB = 0
  beforeAll(() => {
    const serverId = saveServer({ name: 'S1', host: '10.0.0.1', port: 22, username: 'deployer', hostKey: 'ssh-ed25519 AAAAtest', publicIp: '', maxClubs: 5, acceptsNew: true })
    const mk = (name: string) => insertClub({ name, displayName: name, serverId, status: 'running', image: 'img:1', modules: [], customDomains: [], secrets: {}, extraEnv: '', timezone: '', memoryMb: 700, ownerEmail: '', ownerName: '', notes: '' }).id
    siteA = mk('alpha'); siteB = mk('bravo')
  })

  it('existing and first admins are owners', () => {
    const id = createAdmin('boss@example.com', 'Boss', 'correct horse battery')
    expect(getAdmin(id)?.role).toBe('owner')
    expect(ownerCount()).toBe(1)
  })

  it('invites, then the link works once', () => {
    const { id, token } = inviteAdmin('Emp@Example.com', 'Emp', { role: 'viewer', allSites: false, siteIds: [siteA] }, 'boss@example.com')
    const person = getAdmin(id)!
    expect(person).toMatchObject({ email: 'emp@example.com', role: 'viewer', allSites: false, siteIds: [siteA], invited: true })
    // Can't sign in before accepting, whatever the password.
    expect(checkPassword('emp@example.com', 'anything at all')).toBeNull()
    expect(findInvite(token)?.id).toBe(id)
    expect(findInvite('not-a-real-token-xxxxxxxx')).toBeNull()
    expect(acceptInvite(token, 'a good long password')).toBe(id)
    expect(acceptInvite(token, 'again and again')).toBeNull()
    expect(checkPassword('emp@example.com', 'a good long password')).toBe(id)
    expect(getAdmin(id)?.invited).toBe(false)
    expect(ownerEmails()).toEqual(['boss@example.com']) // alerts go to owners only
  })

  it('expired and renewed links', () => {
    const { id, token } = inviteAdmin('late@example.com', '', { role: 'operator', allSites: true, siteIds: [] }, 'boss@example.com')
    db().prepare('UPDATE admins SET invite_expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', id)
    expect(findInvite(token)).toBeNull()
    const fresh = renewInvite(id)!
    expect(findInvite(fresh)?.id).toBe(id)
    expect(findInvite(token)).toBeNull()
  })

  it('changes access and keeps only real sites', () => {
    const { id } = inviteAdmin('ops@example.com', '', { role: 'viewer', allSites: false, siteIds: [siteA] }, 'x')
    setAccess(id, { role: 'operator', allSites: false, siteIds: [siteB, 99999] })
    expect(getAdmin(id)).toMatchObject({ role: 'operator', allSites: false, siteIds: [siteB] })
    setAccess(id, { role: 'owner', allSites: false, siteIds: [siteA] })
    expect(getAdmin(id)).toMatchObject({ role: 'owner', allSites: true, siteIds: [] })
  })

  it('a removed site drops off everyone’s list', () => {
    const { id } = inviteAdmin('gone@example.com', '', { role: 'viewer', allSites: false, siteIds: [siteA, siteB] }, 'x')
    db().prepare('DELETE FROM clubs WHERE id = ?').run(siteB)
    expect(getAdmin(id)?.siteIds).toEqual([siteA])
  })

  it('suspended people can’t sign in and lose their sessions', () => {
    const id = createAdmin('sus@example.com', '', 'another long password')
    db().prepare("INSERT INTO sessions (token_hash, admin_id, second_factor, expires_at, created_at) VALUES ('h', ?, 1, '2999-01-01', '2020-01-01')").run(id)
    setSuspended(id, true)
    expect(checkPassword('sus@example.com', 'another long password')).toBeNull()
    expect((db().prepare('SELECT COUNT(*) AS n FROM sessions WHERE admin_id = ?').get(id) as { n: number }).n).toBe(0)
    setSuspended(id, false)
    expect(checkPassword('sus@example.com', 'another long password')).toBe(id)
  })
})

describe('access log', () => {
  it('records actions and one log read per site per hour', async () => {
    const me = { id: 1, email: 'boss@example.com' }
    await audit(me, 'settings', { detail: 'Platform settings' })
    await auditView(me, 'viewed-logs', { id: 7, name: 'alpha' })
    await auditView(me, 'viewed-logs', { id: 7, name: 'alpha' })
    await auditView(me, 'viewed-logs', { id: 8, name: 'bravo' })
    const entries = listAudit()
    expect(entries.filter((e) => e.action === 'viewed-logs')).toHaveLength(2)
    expect(entries[entries.length - 1]).toMatchObject({ action: 'settings', actorEmail: 'boss@example.com', detail: 'Platform settings' })
  })
})

// Every server action has to check who is calling it. This catches a new
// action (or an edited one) that forgot to.
describe('every server action checks access', () => {
  // The core's pages and every plugin's own actions (any file that starts with 'use server').
  const root = path.resolve(__dirname, '../src')
  const files: string[] = []
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.ts$/.test(e.name) && /^'use server'/.test(fs.readFileSync(p, 'utf8'))) files.push(p)
    }
  }
  walk(path.join(root, 'app'))
  walk(path.join(root, 'plugins'))
  // Actions any signed-in person may run (they check the site themselves, or only touch your own account).
  const ANY_ADMIN = new Set(['checkNowAction', 'changeOwnPasswordAction'])
  // Sign-in pages: no session yet.
  const PUBLIC = new Set(['loginAction', 'codeAction', 'setupAction', 'inviteAction', 'logoutAction'])

  it('finds the action files', () => expect(files.length).toBeGreaterThan(5))
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8')
    const parts = src.split(/^export async function /m).slice(1)
    for (const part of parts) {
      const name = part.slice(0, part.indexOf('('))
      it(`${path.relative(root, file)}: ${name}`, () => {
        if (PUBLIC.has(name)) return
        const body = part.slice(0, 600)
        if (ANY_ADMIN.has(name)) expect(body).toMatch(/requireAdmin\(\)/)
        else expect(body).toMatch(/requireOwner\(\)|siteFor\(|requireSite\(|projectFor\(|requireProject\(/)
      })
    }
  }
})

describe('every admin API route checks access', () => {
  const root = path.resolve(__dirname, '../src/app/api/admin')
  const routes: string[] = []
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name === 'route.ts') routes.push(p)
    }
  }
  walk(root)
  it('finds the routes', () => expect(routes.length).toBeGreaterThan(3))
  for (const file of routes) {
    it(path.relative(root, file), () => {
      const src = fs.readFileSync(file, 'utf8')
      expect(src).toMatch(/currentAdmin\(\)/)
      expect(src).toMatch(/canSeeSite\(|isOwner\(|role !== 'owner'/)
    })
  }
})
