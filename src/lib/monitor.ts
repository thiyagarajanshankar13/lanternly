import dns from 'node:dns/promises'
import net from 'node:net'
import tls from 'node:tls'
import { ownerEmails } from './auth'
import { listClubs } from './clubs'
import { decrypt, encrypt } from './crypto'
import { db, now } from './db'
import { isFakeEngine } from './engine'
import { mailReady, sendMail } from './mail'
import { getSettings } from './settings'
import { clubStatsKey } from './statsKey'
import { isEmail } from './validate'

// Monitoring: the deployer checks every watched site on a timer. Its own
// sites are added by themselves; sites hosted elsewhere (another AWS VM,
// Railway…) are added by web address. Watching only: nothing here can
// restart or change a site.
//
// A check asks <site>/api/health (an app that has one answers with its version; Avrosphere does). A
// site without that endpoint counts as up when its home page loads.

export type WatchStatus = 'unknown' | 'up' | 'down'

export type WatchedSite = {
  id: number
  name: string
  url: string
  clubId: number | null
  /** Apps: the page asked instead of /api/health (any answer under 400 = up). */
  healthPath: string
  paused: boolean
  status: WatchStatus
  fails: number
  statusSince: string | null
  lastCheckedAt: string | null
  lastMs: number | null
  lastError: string
  hasHealth: boolean
  version: string
  commit: string
  certExpiresAt: string | null
  certCheckedAt: string | null
  certAlertLevel: number
  createdAt: string
  /** A key is saved for a site hosted elsewhere (never sent to the browser). */
  hasStatsKey: boolean
  statsCheckedAt: string | null
  statsError: string
  /** User numbers from the site's /api/health/stats; null until read. */
  members: number | null
  staff: number | null
  membersActive: number | null
  membersNew: number | null
}

type Row = {
  id: number; name: string; url: string; club_id: number | null; paused: number; status: string; fails: number
  status_since: string | null; last_checked_at: string | null; last_ms: number | null; last_error: string
  has_health: number; version: string; commit_sha: string; cert_expires_at: string | null; cert_checked_at: string | null
  cert_alert_level: number; created_at: string
  stats_key_enc: string; stats_checked_at: string | null; stats_error: string
  members: number | null; staff: number | null; members_active: number | null; members_new: number | null
  health_path: string
}

const toSite = (r: Row): WatchedSite => ({
  id: r.id, name: r.name, url: r.url, clubId: r.club_id, healthPath: r.health_path ?? '', paused: !!r.paused, status: r.status as WatchStatus, fails: r.fails,
  statusSince: r.status_since, lastCheckedAt: r.last_checked_at, lastMs: r.last_ms, lastError: r.last_error,
  hasHealth: !!r.has_health, version: r.version, commit: r.commit_sha, certExpiresAt: r.cert_expires_at,
  certCheckedAt: r.cert_checked_at, certAlertLevel: r.cert_alert_level, createdAt: r.created_at,
  hasStatsKey: !!r.stats_key_enc, statsCheckedAt: r.stats_checked_at, statsError: r.stats_error,
  members: r.members, staff: r.staff, membersActive: r.members_active, membersNew: r.members_new,
})

/** Failed checks in a row before a site counts as down (one blip isn't an outage). */
export const FAILS_BEFORE_DOWN = 2
/** Certificate warnings go out at these many days left. */
export const CERT_LEVELS = [14, 3]
const KEEP_DAYS = 14
const TIMEOUT_MS = 10_000
const CERT_EVERY_MS = 12 * 3600_000
const STATS_EVERY_MS = 3600_000
const STATS_KEEP_DAYS = 400

// ---------- the list ----------

export function listWatched(): WatchedSite[] {
  return (db().prepare('SELECT * FROM watched_sites ORDER BY name COLLATE NOCASE').all() as Row[]).map(toSite)
}
export function getWatched(id: number): WatchedSite | null {
  const r = db().prepare('SELECT * FROM watched_sites WHERE id = ?').get(id) as Row | undefined
  return r ? toSite(r) : null
}

/** What people type → "https://example.com" (scheme + host + port only), or null. */
export function cleanSiteUrl(input: string): string | null {
  let text = input.trim()
  if (!text) return null
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`
  let url: URL
  try { url = new URL(text) } catch { return null }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (!url.hostname || url.username || url.password) return null
  if (!url.hostname.includes('.') && url.hostname !== 'localhost' && !net.isIP(url.hostname)) return null
  return url.origin.toLowerCase()
}

export function addWatched(name: string, url: string): WatchedSite {
  const info = db().prepare('INSERT INTO watched_sites (name, url, created_at) VALUES (?, ?, ?)').run(name, url, now())
  return getWatched(Number(info.lastInsertRowid))!
}
export function updateWatched(id: number, patch: { name?: string; url?: string; paused?: boolean }) {
  const site = getWatched(id)
  if (!site) return
  const url = patch.url ?? site.url
  db().prepare('UPDATE watched_sites SET name = ?, url = ?, paused = ? WHERE id = ?')
    .run(patch.name ?? site.name, url, (patch.paused ?? site.paused) ? 1 : 0, id)
  // A new address is a new site as far as its state goes.
  if (url !== site.url) {
    db().prepare(`UPDATE watched_sites SET status = 'unknown', fails = 0, status_since = NULL, last_checked_at = NULL, last_ms = NULL, last_error = '',
      has_health = 0, version = '', commit_sha = '', cert_expires_at = NULL, cert_checked_at = NULL, cert_alert_level = 0,
      stats_checked_at = NULL, stats_error = '' WHERE id = ?`).run(id)
  }
}
export function removeWatched(id: number) {
  db().prepare('DELETE FROM watched_sites WHERE id = ? AND club_id IS NULL').run(id)
}
export function urlWatched(url: string, exceptId?: number): boolean {
  return !!db().prepare('SELECT 1 FROM watched_sites WHERE url = ? AND id IS NOT ?').get(url, exceptId ?? null)
}

/** Keeps one row per site the deployer runs, named and addressed like the site. */
export function syncDeployerSites() {
  const base = getSettings().baseDomain
  const have = new Map((db().prepare('SELECT * FROM watched_sites WHERE club_id IS NOT NULL').all() as Row[]).map((r) => [r.club_id!, r]))
  for (const club of listClubs()) {
    // No web address: databases (the database monitor watches them) and apps only reachable inside their project.
    if (club.kind === 'postgres' || !club.appPublic) { const old = have.get(club.id); if (old) removeWatched(old.id); continue }
    const url = `https://${club.name}.${base}`
    const name = club.displayName || club.name
    const healthPath = club.kind === 'app' ? club.appHealthPath || '/' : club.kind === 'minio' ? '/minio/health/live' : ''
    const row = have.get(club.id)
    if (!row) db().prepare('INSERT INTO watched_sites (name, url, club_id, health_path, created_at) VALUES (?, ?, ?, ?, ?)').run(name, url, club.id, healthPath, now())
    else {
      if (row.name !== name || row.url !== url) updateWatched(row.id, { name, url })
      if ((row.health_path ?? '') !== healthPath) db().prepare('UPDATE watched_sites SET health_path = ? WHERE id = ?').run(healthPath, row.id)
    }
  }
}

// ---------- one check ----------

export type CheckResult = { ok: boolean; ms: number | null; error: string; hasHealth: boolean; version: string; commit: string }

const allowPrivate = () => /^(1|true|yes|on)$/i.test(process.env.DEPLOYER_MONITOR_ALLOW_PRIVATE || '')

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
  }
  const v6 = ip.toLowerCase()
  if (v6.startsWith('::ffff:')) return isPrivateIp(v6.slice(7))
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80')
}

/** The deployer only watches public addresses, never its own network. */
async function privateHostError(hostname: string): Promise<string | null> {
  if (allowPrivate()) return null
  const host = hostname.replace(/^\[|\]$/g, '')
  try {
    const found = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true })
    if (found.some((f) => isPrivateIp(f.address))) return 'That address is on a private network, which the deployer does not check.'
    return null
  } catch {
    return "The address doesn't exist (no DNS record)."
  }
}

function plainError(err: unknown): string {
  const e = err as Error & { cause?: { code?: string; message?: string } }
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return `No answer within ${TIMEOUT_MS / 1000} seconds.`
  const code = e.cause?.code || ''
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return "The address doesn't exist (no DNS record)."
  if (code === 'ECONNREFUSED') return 'The server refused the connection.'
  if (code === 'ECONNRESET') return 'The connection was dropped.'
  if (code === 'CERT_HAS_EXPIRED') return 'The HTTPS certificate has expired.'
  if (/CERT|SSL|TLS|SELF_SIGNED|ALTNAME/i.test(code)) return `The HTTPS certificate is not valid (${code}).`
  return (e.cause?.message || e.message || 'The request failed.').slice(0, 200)
}

async function timed(url: string): Promise<{ res: Response; ms: number }> {
  const started = performance.now()
  const res = await fetch(url, {
    redirect: 'follow', cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'User-Agent': 'Deployer-Monitor/1', Accept: 'application/json, text/html;q=0.8' },
  })
  return { res, ms: Math.round(performance.now() - started) }
}

/** Asks the site whether it is up. Never throws. `healthPath`: an app's own "I'm up" page. */
export async function checkUrl(origin: string, healthPath = ''): Promise<CheckResult> {
  const fail = (error: string, hasHealth = false): CheckResult => ({ ok: false, ms: null, error, hasHealth, version: '', commit: '' })
  const blocked = await privateHostError(new URL(origin).hostname)
  if (blocked) return fail(blocked)
  if (healthPath) {
    try {
      const page = await timed(`${origin}${healthPath}`)
      await page.res.body?.cancel().catch(() => {})
      if (page.res.status >= 400) return fail(`${healthPath} answered with an error (${page.res.status}).`)
      return { ok: true, ms: page.ms, error: '', hasHealth: false, version: '', commit: '' }
    } catch (err) {
      return fail(plainError(err))
    }
  }
  let health: { res: Response; ms: number }
  try { health = await timed(`${origin}/api/health`) } catch (err) { return fail(plainError(err)) }
  if (health.res.ok) {
    const body = await health.res.json().catch(() => null) as { ok?: unknown; app?: unknown; version?: unknown; commit?: unknown } | null
    if (body && typeof body === 'object' && 'ok' in body) {
      if (body.ok !== true) return fail('The site answered, but reports a problem.', true)
      return {
        ok: true, ms: health.ms, error: '', hasHealth: true,
        version: typeof body.version === 'string' ? body.version.slice(0, 40) : '',
        commit: typeof body.commit === 'string' ? body.commit.slice(0, 40) : '',
      }
    }
  } else {
    await health.res.body?.cancel().catch(() => {})
    if (health.res.status >= 500) return fail(`The site answered with an error (${health.res.status}).`)
  }
  // No health endpoint (an app without one): the home page decides.
  try {
    const home = await timed(`${origin}/`)
    await home.res.body?.cancel().catch(() => {})
    if (home.res.status >= 400) return fail(`The home page answered with an error (${home.res.status}).`)
    return { ok: true, ms: home.ms, error: '', hasHealth: false, version: '', commit: '' }
  } catch (err) {
    return fail(plainError(err))
  }
}

/** When the site's HTTPS certificate runs out (ISO), or null if it can't be read. */
export function certExpiry(origin: string): Promise<string | null> {
  const url = new URL(origin)
  if (url.protocol !== 'https:') return Promise.resolve(null)
  return new Promise((resolve) => {
    const socket = tls.connect({ host: url.hostname, port: Number(url.port) || 443, servername: net.isIP(url.hostname) ? undefined : url.hostname, rejectUnauthorized: false, timeout: TIMEOUT_MS })
    const done = (value: string | null) => { socket.destroy(); resolve(value) }
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate()
      const at = cert?.valid_to ? new Date(cert.valid_to) : null
      done(at && !Number.isNaN(at.getTime()) ? at.toISOString() : null)
    })
    socket.once('timeout', () => done(null))
    socket.once('error', () => done(null))
  })
}

export function daysLeft(iso: string | null, at = Date.now()): number | null {
  if (!iso) return null
  return Math.floor((new Date(iso).getTime() - at) / 86_400_000)
}

/** The warning level a certificate is at: 0 fine, 14 = two weeks or less, 3 = three days or less. */
export function certLevel(days: number | null): number {
  if (days === null) return 0
  let level = 0
  for (const l of CERT_LEVELS) if (days <= l) level = l
  return level
}

// ---------- user numbers ----------

export type SiteNumbers = { members: number; staff: number; membersActive: number; membersNew: number }
export type StatsResult = { numbers: SiteNumbers | null; error: string }

/** Saves (or clears, with '') the key of a site hosted elsewhere. Stored encrypted. */
export function setStatsKey(id: number, key: string) {
  db().prepare("UPDATE watched_sites SET stats_key_enc = ?, stats_checked_at = NULL, stats_error = '' WHERE id = ?").run(key ? encrypt(key) : '', id)
  if (!key) db().prepare('UPDATE watched_sites SET members = NULL, staff = NULL, members_active = NULL, members_new = NULL WHERE id = ?').run(id)
}

/** The key the deployer presents to a site: derived for its own sites, the saved one otherwise. */
function statsKeyOf(siteId: number): string {
  const r = db().prepare('SELECT w.stats_key_enc AS enc, c.name AS club FROM watched_sites w LEFT JOIN clubs c ON c.id = w.club_id WHERE w.id = ?').get(siteId) as { enc: string; club: string | null } | undefined
  if (!r) return ''
  if (r.club) return clubStatsKey(r.club)
  try { return r.enc ? decrypt(r.enc) : '' } catch { return '' }
}

const wholeNumber = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0

/** Reads a site's user numbers from /api/health/stats. Never throws. */
export async function fetchStats(origin: string, key: string, ownSite = false): Promise<StatsResult> {
  const fail = (error: string): StatsResult => ({ numbers: null, error })
  if (!key) return fail('')
  // The key is a secret: only ever over HTTPS, and never passed on to another address.
  if (!origin.startsWith('https:') && !allowPrivate()) return fail('Numbers are only read over HTTPS.')
  const blocked = await privateHostError(new URL(origin).hostname)
  if (blocked) return fail(blocked)
  let res: Response
  try {
    res = await fetch(`${origin}/api/health/stats`, {
      redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'User-Agent': 'Deployer-Monitor/1', Accept: 'application/json', Authorization: `Bearer ${key}` },
    })
  } catch (err) { return fail(plainError(err)) }
  if (res.status >= 300 && res.status < 400) return fail('The address redirects somewhere else. Use the address the site ends up on.')
  if (res.status === 404) return fail(ownSite
    ? 'Not available yet: the site needs a version that reports user numbers, or its settings applied once more (any change on its page does that).'
    : 'Not available: the site needs a version that reports user numbers, with STATS_API_KEY set on it.')
  if (res.status === 401) return fail("The key doesn't match the STATS_API_KEY set on the site.")
  if (!res.ok) return fail(`The site answered with an error (${res.status}).`)
  const body = await res.json().catch(() => null) as Record<string, unknown> | null
  if (!body || !wholeNumber(body.members) || !wholeNumber(body.staff)) return fail('The site answered, but not with numbers.')
  return {
    numbers: { members: body.members, staff: body.staff, membersActive: wholeNumber(body.membersActive) ? body.membersActive : 0, membersNew: wholeNumber(body.membersNew) ? body.membersNew : 0 },
    error: '',
  }
}

/** Stores a stats answer: the latest numbers on the site, and one row for the day (UTC). */
export function recordStats(siteId: number, result: StatsResult, at = now()) {
  if (!result.numbers) {
    db().prepare('UPDATE watched_sites SET stats_checked_at = ?, stats_error = ? WHERE id = ?').run(at, result.error, siteId)
    return
  }
  const n = result.numbers
  db().prepare("UPDATE watched_sites SET stats_checked_at = ?, stats_error = '', members = ?, staff = ?, members_active = ?, members_new = ? WHERE id = ?")
    .run(at, n.members, n.staff, n.membersActive, n.membersNew, siteId)
  db().prepare(`INSERT INTO site_stats (site_id, day, members, staff, members_active, members_new) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(site_id, day) DO UPDATE SET members = excluded.members, staff = excluded.staff, members_active = excluded.members_active, members_new = excluded.members_new`)
    .run(siteId, at.slice(0, 10), n.members, n.staff, n.membersActive, n.membersNew)
}

/** Reads and stores a site's numbers now (when a key is known for it). */
export async function refreshStats(siteId: number): Promise<void> {
  const site = getWatched(siteId)
  if (!site) return
  const key = statsKeyOf(siteId)
  if (!key) return
  recordStats(siteId, await fetchStats(site.url, key, site.clubId !== null))
}

export type StatsDay = { day: string } & SiteNumbers

/** One row per day, newest first. */
export function listStatsDays(siteId: number, limit = 30): StatsDay[] {
  return db().prepare('SELECT day, members, staff, members_active AS membersActive, members_new AS membersNew FROM site_stats WHERE site_id = ? ORDER BY day DESC LIMIT ?').all(siteId, limit) as StatsDay[]
}

// ---------- state + alerts ----------

export type Alert = { kind: 'down' | 'up' | 'cert'; subject: string; text: string }
type Sender = (alert: Alert, site: WatchedSite) => Promise<void> | void

const g = globalThis as unknown as { __monitorTimer?: NodeJS.Timeout; __monitorBusy?: boolean; __monitorSender?: Sender }

export function alertRecipients(): string[] {
  const typed = getSettings().alertEmails.split(/[,;\s]+/).map((e) => e.trim().toLowerCase()).filter(isEmail)
  return typed.length ? [...new Set(typed)] : ownerEmails()
}

async function sendAlert(alert: Alert, site: WatchedSite) {
  if (g.__monitorSender) return g.__monitorSender(alert, site)
  if (!mailReady()) return
  const error = await sendMail(alertRecipients(), alert.subject, alert.text)
  if (error) console.error(`[monitor] alert for ${site.name} not sent: ${error}`)
}
/** Tests only: catch alerts instead of emailing them. */
export function setAlertSenderForTests(sender: Sender | undefined) { g.__monitorSender = sender }

export function fmtDuration(ms: number): string {
  const mins = Math.max(1, Math.round(ms / 60_000))
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'}`
  const hours = Math.floor(mins / 60), rest = mins % 60
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}${rest ? ` ${rest} min` : ''}`
  return `${Math.round(hours / 24)} days`
}

/** Stores one check result, moves the site between up and down, and alerts on a change. */
export async function recordCheck(siteId: number, result: CheckResult, at = now()): Promise<WatchedSite | null> {
  const before = getWatched(siteId)
  if (!before) return null
  db().prepare('INSERT INTO site_checks (site_id, at, ok, ms, error, version) VALUES (?, ?, ?, ?, ?, ?)')
    .run(siteId, at, result.ok ? 1 : 0, result.ms, result.error, result.version)
  const fails = result.ok ? 0 : before.fails + 1
  let status: WatchStatus = before.status
  if (result.ok) status = 'up'
  else if (fails >= FAILS_BEFORE_DOWN) status = 'down'
  const changed = status !== before.status
  db().prepare(`UPDATE watched_sites SET status = ?, fails = ?, status_since = ?, last_checked_at = ?, last_ms = ?, last_error = ?,
    has_health = ?, version = ?, commit_sha = ? WHERE id = ?`).run(
    status, fails, changed ? at : before.statusSince, at, result.ms, result.error,
    result.ok ? (result.hasHealth ? 1 : 0) : (before.hasHealth ? 1 : 0),
    result.ok ? result.version : before.version, result.ok ? result.commit : before.commit, siteId,
  )
  const after = getWatched(siteId)!
  if (changed && status === 'down') {
    await sendAlert({
      kind: 'down', subject: `Down: ${after.name}`,
      text: `${after.name} (${after.url}) is not answering.\n\nWhat the check saw: ${result.error}\nFailed checks in a row: ${fails}\n\nYou'll get another email when it is back.`,
    }, after)
  } else if (changed && status === 'up' && before.status === 'down') {
    const downFor = before.statusSince ? fmtDuration(new Date(at).getTime() - new Date(before.statusSince).getTime()) : ''
    await sendAlert({
      kind: 'up', subject: `Back up: ${after.name}`,
      text: `${after.name} (${after.url}) is answering again${downFor ? ` after about ${downFor}` : ''}.`,
    }, after)
  }
  return after
}

/** Stores a certificate date and warns once per level (14 days, then 3). */
export async function recordCert(siteId: number, expiresAt: string | null, at = now()) {
  const site = getWatched(siteId)
  if (!site) return
  if (!expiresAt) { db().prepare('UPDATE watched_sites SET cert_checked_at = ? WHERE id = ?').run(at, siteId); return }
  const days = daysLeft(expiresAt, new Date(at).getTime())
  const level = certLevel(days)
  db().prepare('UPDATE watched_sites SET cert_expires_at = ?, cert_checked_at = ?, cert_alert_level = ? WHERE id = ?').run(expiresAt, at, level, siteId)
  // Levels count down (14 → 3): warn only when it gets more urgent.
  const moreUrgent = level !== 0 && (site.certAlertLevel === 0 || level < site.certAlertLevel)
  if (!moreUrgent) return
  const when = days !== null && days < 0 ? 'has expired' : days === 0 ? 'expires today' : `expires in ${days} day${days === 1 ? '' : 's'}`
  await sendAlert({
    kind: 'cert', subject: `Certificate ${when}: ${site.name}`,
    text: `The HTTPS certificate for ${site.name} (${site.url}) ${when} (${expiresAt.slice(0, 10)}).\n\nCertificates normally renew by themselves about a month ahead, so this one is stuck. Browsers will show a warning once it runs out.`,
  }, site)
}

/** Checks one site now and stores the result. */
export async function checkSite(siteId: number, opts: { cert?: boolean; stats?: boolean } = {}): Promise<WatchedSite | null> {
  const site = getWatched(siteId)
  if (!site) return null
  const result = await checkUrl(site.url, site.healthPath)
  const after = await recordCheck(siteId, result)
  const certDue = opts.cert || !site.certCheckedAt || Date.now() - new Date(site.certCheckedAt).getTime() > CERT_EVERY_MS
  if (certDue && site.url.startsWith('https:') && !result.error.includes('private network')) {
    await recordCert(siteId, await certExpiry(site.url))
  }
  // Apps don't report user numbers.
  if (site.healthPath) return after ? getWatched(siteId) : null
  const statsDue = opts.stats || !site.statsCheckedAt || Date.now() - new Date(site.statsCheckedAt).getTime() > STATS_EVERY_MS
  if (result.ok && statsDue) await refreshStats(siteId)
  return after ? getWatched(siteId) : null
}

/** A deployer site is only checked while it is meant to be running. */
function clubStates(): Map<number, string> {
  return new Map(listClubs().map((c) => [c.id, c.status]))
}
export function isChecked(site: WatchedSite, states = clubStates()): boolean {
  if (site.paused) return false
  if (site.clubId === null) return true
  return states.get(site.clubId) === 'running'
}

/** One pass: checks every site whose turn has come. Returns how many were checked. */
export async function runDueChecks(opts: { force?: boolean } = {}): Promise<number> {
  if (g.__monitorBusy) return 0
  g.__monitorBusy = true
  try {
    if (!isFakeEngine()) syncDeployerSites()
    const every = Math.min(60, Math.max(1, getSettings().monitorMinutes)) * 60_000
    const states = clubStates()
    const due = listWatched().filter((s) => isChecked(s, states) && (opts.force || !s.lastCheckedAt || Date.now() - new Date(s.lastCheckedAt).getTime() >= every - 5_000))
    const queue = [...due]
    await Promise.all(Array.from({ length: Math.min(5, queue.length) }, async () => {
      for (let site = queue.shift(); site; site = queue.shift()) {
        try { await checkSite(site.id) } catch (err) { console.error(`[monitor] check of ${site.name} failed:`, (err as Error).message) }
      }
    }))
    db().prepare('DELETE FROM site_checks WHERE at < ?').run(new Date(Date.now() - KEEP_DAYS * 86_400_000).toISOString())
    db().prepare('DELETE FROM site_stats WHERE day < ?').run(new Date(Date.now() - STATS_KEEP_DAYS * 86_400_000).toISOString().slice(0, 10))
    return due.length
  } finally {
    g.__monitorBusy = false
  }
}

/** Starts the timer (once per process). DEPLOYER_MONITOR=off stops it. */
export function startMonitor() {
  if (g.__monitorTimer || /^(0|false|no|off)$/i.test(process.env.DEPLOYER_MONITOR || '')) return
  const tick = () => { runDueChecks().catch((err) => console.error('[monitor]', (err as Error).message)) }
  g.__monitorTimer = setInterval(tick, 60_000)
  g.__monitorTimer.unref?.()
  setTimeout(tick, 15_000).unref?.()
}

// ---------- reading ----------

export type CheckRow = { id: number; at: string; ok: boolean; ms: number | null; error: string; version: string }

export function listChecks(siteId: number, limit = 60): CheckRow[] {
  return (db().prepare('SELECT id, at, ok, ms, error, version FROM site_checks WHERE site_id = ? ORDER BY id DESC LIMIT ?').all(siteId, limit) as (Omit<CheckRow, 'ok'> & { ok: number })[])
    .map((r) => ({ ...r, ok: !!r.ok }))
}

/** Share of checks that passed since `hours` ago (0–100, one decimal), and the usual speed. */
export function uptime(siteId: number, hours: number, at = Date.now()): { percent: number | null; checks: number; avgMs: number | null } {
  const r = db().prepare('SELECT COUNT(*) AS n, SUM(ok) AS ok, AVG(CASE WHEN ok = 1 THEN ms END) AS avg FROM site_checks WHERE site_id = ? AND at >= ?')
    .get(siteId, new Date(at - hours * 3600_000).toISOString()) as { n: number; ok: number | null; avg: number | null }
  return { percent: r.n ? Math.round(((r.ok ?? 0) / r.n) * 1000) / 10 : null, checks: r.n, avgMs: r.avg === null ? null : Math.round(r.avg) }
}

/**
 * The version watched sites are compared with ("1.5.0"), from a plugin that
 * knows its app's releases (Avrosphere: its newest release), else '' (no
 * comparison).
 */
export async function latestVersion(): Promise<string> {
  const { latestAppVersion } = await import('@/plugins/server')
  return latestAppVersion()
}

/** -1, 0 or 1 for two x.y.z versions (0 when either isn't one). */
export function compareVersions(a: string, b: string): number {
  const x = /^v?(\d+)\.(\d+)\.(\d+)/.exec(a), y = /^v?(\d+)\.(\d+)\.(\d+)/.exec(b)
  if (!x || !y) return 0
  for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) > Number(y[i]) ? 1 : -1
  return 0
}

/** True when the site runs an older version than `latest` ("1.3.0"). */
export function isBehind(version: string, latest: string): boolean {
  if (!latest || !version) return false
  return compareVersions(version.replace(/-.*$/, ''), latest.replace(/-.*$/, '')) < 0
}
