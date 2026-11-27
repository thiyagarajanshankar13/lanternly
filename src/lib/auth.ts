import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { db, now } from './db'
import { decrypt, encrypt, hashPassword, randomToken, sha256, verifyPassword } from './crypto'
import { newTotpSecret, verifyTotp } from './totp'
import { type Access, type Role, isRole } from './access'

// Admin sign-in for the deployer: password, then a code from an
// authenticator app. A session only counts once the second step is done.

const COOKIE = 'deployer_session'
const SESSION_HOURS = 12
const PENDING_MINUTES = 10

const INVITE_HOURS = 72

/** A person who can sign in to the deployer. "Admin" in the code, "person" on screen. */
export type Admin = Access & {
  id: number; email: string; name: string; totpConfirmed: boolean
  suspended: boolean; invited: boolean; inviteExpiresAt: string | null; invitedBy: string; lastSignInAt: string | null; createdAt: string
}
type AdminRow = {
  id: number; email: string; name: string; password_hash: string; totp_secret_enc: string | null; totp_confirmed: number
  role: string; all_sites: number; suspended: number; invite_hash: string | null; invite_expires_at: string | null; invited_by: string
  last_sign_in_at: string | null; created_at: string
}

export function adminCount(): number {
  return (db().prepare('SELECT COUNT(*) AS n FROM admins').get() as { n: number }).n
}
function adminRow(id: number) {
  return db().prepare('SELECT * FROM admins WHERE id = ?').get(id) as AdminRow | undefined
}
function siteIdsOf(id: number): number[] {
  return (db().prepare('SELECT club_id FROM admin_sites WHERE admin_id = ? ORDER BY club_id').all(id) as { club_id: number }[]).map((r) => r.club_id)
}
function projectIdsOf(id: number): number[] {
  return (db().prepare('SELECT project_id FROM admin_projects WHERE admin_id = ? ORDER BY project_id').all(id) as { project_id: number }[]).map((r) => r.project_id)
}
/** Every service in the projects given to someone (so new services in them come along). */
function projectSiteIdsOf(id: number): number[] {
  return (db().prepare('SELECT c.id FROM clubs c JOIN admin_projects ap ON ap.project_id = c.project_id WHERE ap.admin_id = ? ORDER BY c.id').all(id) as { id: number }[]).map((r) => r.id)
}
const toAdmin = (r: AdminRow): Admin => {
  const role: Role = isRole(r.role) ? r.role : 'viewer'
  const scoped = role !== 'owner'
  return {
    id: r.id, email: r.email, name: r.name, totpConfirmed: !!r.totp_confirmed,
    role, allSites: role === 'owner' || !!r.all_sites, siteIds: scoped ? siteIdsOf(r.id) : [],
    projectIds: scoped ? projectIdsOf(r.id) : [], projectSiteIds: scoped ? projectSiteIdsOf(r.id) : [],
    suspended: !!r.suspended, invited: !!r.invite_hash, inviteExpiresAt: r.invite_expires_at, invitedBy: r.invited_by ?? '',
    lastSignInAt: r.last_sign_in_at, createdAt: r.created_at,
  }
}

export function createAdmin(email: string, name: string, password: string): number {
  const info = db().prepare('INSERT INTO admins (email, name, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .run(email.trim().toLowerCase(), name.trim(), hashPassword(password), now())
  return Number(info.lastInsertRowid)
}
export function listAdmins(): Admin[] {
  return (db().prepare('SELECT * FROM admins ORDER BY email').all() as AdminRow[]).map(toAdmin)
}
export function getAdmin(id: number): Admin | null {
  const row = adminRow(id)
  return row ? toAdmin(row) : null
}
/** Owners who can sign in (not suspended, invite accepted). */
export function ownerCount(): number {
  return (db().prepare("SELECT COUNT(*) AS n FROM admins WHERE role = 'owner' AND suspended = 0 AND invite_hash IS NULL").get() as { n: number }).n
}
/** Emails of the owners, for alerts that go to "every admin". */
export function ownerEmails(): string[] {
  return listAdmins().filter((a) => a.role === 'owner' && !a.suspended && !a.invited).map((a) => a.email)
}

// ── People and access ────────────────────────────────────────────────────────
export type AccessInput = { role: Role; allSites: boolean; siteIds: number[]; projectIds?: number[] }

function writeSites(id: number, access: AccessInput) {
  db().prepare('DELETE FROM admin_sites WHERE admin_id = ?').run(id)
  db().prepare('DELETE FROM admin_projects WHERE admin_id = ?').run(id)
  if (access.role === 'owner' || access.allSites) return
  const add = db().prepare('INSERT OR IGNORE INTO admin_sites (admin_id, club_id) SELECT ?, id FROM clubs WHERE id = ?')
  for (const clubId of new Set(access.siteIds)) add.run(id, clubId)
  const addProject = db().prepare('INSERT OR IGNORE INTO admin_projects (admin_id, project_id) SELECT ?, id FROM projects WHERE id = ?')
  for (const projectId of new Set(access.projectIds ?? [])) addProject.run(id, projectId)
}

/** Adds someone who picks their own password through a one-time link. Returns the link's token. */
export function inviteAdmin(email: string, name: string, access: AccessInput, invitedBy: string): { id: number; token: string } {
  const token = randomToken()
  const expires = new Date(Date.now() + INVITE_HOURS * 3600000).toISOString()
  const id = db().transaction(() => {
    // Nobody can sign in with this: the hash is of a password no one knows.
    const info = db().prepare(
      'INSERT INTO admins (email, name, password_hash, role, all_sites, invite_hash, invite_expires_at, invited_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(email.trim().toLowerCase(), name.trim(), hashPassword(randomToken()), access.role, access.allSites ? 1 : 0, sha256(token), expires, invitedBy, now())
    const newId = Number(info.lastInsertRowid)
    writeSites(newId, access)
    return newId
  })()
  return { id, token }
}
/** A new link for someone who hasn't accepted yet (the old link stops working). */
export function renewInvite(id: number): string | null {
  const row = adminRow(id)
  if (!row?.invite_hash) return null
  const token = randomToken()
  db().prepare('UPDATE admins SET invite_hash = ?, invite_expires_at = ? WHERE id = ?')
    .run(sha256(token), new Date(Date.now() + INVITE_HOURS * 3600000).toISOString(), id)
  return token
}
/** The person an invite link belongs to, if it is still valid. */
export function findInvite(token: string): Admin | null {
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(token)) return null
  const row = db().prepare('SELECT * FROM admins WHERE invite_hash = ?').get(sha256(token)) as AdminRow | undefined
  if (!row || !row.invite_expires_at || row.invite_expires_at < now() || row.suspended) return null
  return toAdmin(row)
}
/** Sets the password chosen on the invite page; the link can't be used again. */
export function acceptInvite(token: string, password: string): number | null {
  const person = findInvite(token)
  if (!person) return null
  db().prepare('UPDATE admins SET password_hash = ?, invite_hash = NULL, invite_expires_at = NULL, totp_secret_enc = NULL, totp_confirmed = 0 WHERE id = ?')
    .run(hashPassword(password), person.id)
  return person.id
}
export function setAccess(id: number, access: AccessInput) {
  db().transaction(() => {
    db().prepare('UPDATE admins SET role = ?, all_sites = ? WHERE id = ?').run(access.role, access.allSites ? 1 : 0, id)
    writeSites(id, access)
  })()
}
export function setAdminName(id: number, name: string) {
  db().prepare('UPDATE admins SET name = ? WHERE id = ?').run(name.trim(), id)
}
/** Suspending signs them out everywhere at once. */
export function setSuspended(id: number, suspended: boolean) {
  db().prepare('UPDATE admins SET suspended = ? WHERE id = ?').run(suspended ? 1 : 0, id)
  if (suspended) db().prepare('DELETE FROM sessions WHERE admin_id = ?').run(id)
}
export function setAdminPassword(id: number, password: string) {
  db().prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hashPassword(password), id)
  db().prepare('DELETE FROM sessions WHERE admin_id = ?').run(id)
}
export function deleteAdmin(id: number) {
  db().prepare('DELETE FROM admins WHERE id = ?').run(id)
}

export function passwordError(password: string): string | null {
  if (password.length < 12) return 'Use at least 12 characters.'
  if (password.length > 200) return 'That password is too long.'
  return null
}

// ── Rate limiting ────────────────────────────────────────────────────────────
/** True when `key` has had `max` failures in the last `minutes`. */
export function tooManyAttempts(key: string, max = 8, minutes = 15): boolean {
  const since = new Date(Date.now() - minutes * 60000).toISOString()
  const row = db().prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE key = ? AND at > ?').get(key, since) as { n: number }
  return row.n >= max
}
export function recordAttempt(key: string) {
  db().prepare('INSERT INTO login_attempts (key, at) VALUES (?, ?)').run(key, now())
  db().prepare('DELETE FROM login_attempts WHERE at < ?').run(new Date(Date.now() - 24 * 3600000).toISOString())
}
export async function clientIp(): Promise<string> {
  const h = await headers()
  return (h.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown'
}

// ── Sessions ─────────────────────────────────────────────────────────────────
/** Checks the password; returns the admin id or null. Same time either way. */
export function checkPassword(email: string, password: string): number | null {
  const row = db().prepare('SELECT * FROM admins WHERE email = ?').get(email.trim().toLowerCase()) as AdminRow | undefined
  const stored = row?.password_hash ?? hashPassword('not-a-real-account')
  const ok = verifyPassword(password, stored)
  // Suspended people and invites not yet accepted can't sign in.
  return ok && row && !row.suspended && !row.invite_hash ? row.id : null
}

export async function startSession(adminId: number, secondFactor: boolean) {
  if (secondFactor) db().prepare('UPDATE admins SET last_sign_in_at = ? WHERE id = ?').run(now(), adminId)
  const token = randomToken()
  const minutes = secondFactor ? SESSION_HOURS * 60 : PENDING_MINUTES
  const expires = new Date(Date.now() + minutes * 60000)
  db().prepare('DELETE FROM sessions WHERE expires_at < ?').run(now())
  db().prepare('INSERT INTO sessions (token_hash, admin_id, second_factor, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(sha256(token), adminId, secondFactor ? 1 : 0, expires.toISOString(), now())
  const jar = await cookies()
  jar.set(COOKIE, token, {
    httpOnly: true, sameSite: 'lax', path: '/', expires,
    secure: (process.env.DEPLOYER_URL || '').startsWith('https://'),
  })
}

export async function endSession() {
  const jar = await cookies()
  const token = jar.get(COOKIE)?.value
  if (token) db().prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token))
  jar.delete(COOKIE)
}

async function readSession(): Promise<{ admin: AdminRow; secondFactor: boolean } | null> {
  const token = (await cookies()).get(COOKIE)?.value
  if (!token) return null
  const s = db().prepare('SELECT admin_id, second_factor, expires_at FROM sessions WHERE token_hash = ?').get(sha256(token)) as
    | { admin_id: number; second_factor: number; expires_at: string } | undefined
  if (!s || s.expires_at < now()) return null
  const admin = adminRow(s.admin_id)
  return admin && !admin.suspended && !admin.invite_hash ? { admin, secondFactor: !!s.second_factor } : null
}

/** The signed-in admin (both steps done), or null. */
export async function currentAdmin(): Promise<Admin | null> {
  const s = await readSession()
  return s && s.secondFactor ? toAdmin(s.admin) : null
}
/** For pages and actions: sends anyone not fully signed in to the login page. */
export async function requireAdmin(): Promise<Admin> {
  const admin = await currentAdmin()
  if (!admin) redirect('/admin/login')
  return admin
}
/** The admin who has passed the password step but not yet the code. */
export async function pendingAdmin(): Promise<Admin | null> {
  const s = await readSession()
  return s && !s.secondFactor ? toAdmin(s.admin) : null
}

// ── Two-step codes ───────────────────────────────────────────────────────────
/** The secret to show while setting up; made on first use, kept until confirmed. */
export function enrolmentSecret(adminId: number): string {
  const row = adminRow(adminId)!
  if (row.totp_secret_enc && !row.totp_confirmed) return decrypt(row.totp_secret_enc)
  const secret = newTotpSecret()
  db().prepare('UPDATE admins SET totp_secret_enc = ?, totp_confirmed = 0 WHERE id = ?').run(encrypt(secret), adminId)
  return secret
}
export function checkCode(adminId: number, code: string): boolean {
  const row = adminRow(adminId)
  if (!row?.totp_secret_enc) return false
  if (!verifyTotp(decrypt(row.totp_secret_enc), code)) return false
  if (!row.totp_confirmed) db().prepare('UPDATE admins SET totp_confirmed = 1 WHERE id = ?').run(adminId)
  return true
}
export function resetTwoStep(adminId: number) {
  db().prepare('UPDATE admins SET totp_secret_enc = NULL, totp_confirmed = 0 WHERE id = ?').run(adminId)
  db().prepare('DELETE FROM sessions WHERE admin_id = ?').run(adminId)
}
