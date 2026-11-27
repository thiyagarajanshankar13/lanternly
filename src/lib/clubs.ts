import { db, now } from './db'
import { decryptJson, encryptJson } from './crypto'
import type { ClubSecrets } from './clubEnv'
import type { ServerRow } from './engine'
import { getSettings } from './settings'
import { createProjectRow, freeProjectName } from './projects'
import { clubNameError } from './validate'

export type ClubStatus = 'creating' | 'running' | 'paused' | 'failed' | 'removing'
/**
 * 'app' = an app built from a GitHub repo + branch (or a Docker image); 'postgres' = a PostgreSQL
 * database service; 'minio' = S3 storage (a MinIO server); anything else is a plugin's kind
 * (the Avrosphere plugin's is 'avrosphere').
 */
export type SiteKind = 'app' | 'postgres' | 'minio' | (string & {})

/** One bucket of an S3 storage service, with the latest numbers from the server. */
export type Bucket = { name: string; public: boolean; objects: number | null; bytes: number | null }

export type Club = {
  id: number
  name: string
  displayName: string
  serverId: number
  status: ClubStatus
  image: string
  /** A plugin kind's switches (Avrosphere: its add-on modules); the core only stores them. */
  modules: string[]
  customDomains: string[]
  secrets: ClubSecrets
  extraEnv: string
  timezone: string
  memoryMb: number
  ownerEmail: string
  ownerName: string
  notes: string
  /** Rollouts skip it (upgrade it from its own page). */
  pinned: boolean
  /** Rollouts reach it before every other site. */
  testSite: boolean
  /** Off-site backups: every 1 or 6 hours (0 = off), kept this many days. */
  backupFrequentHours: number
  backupFrequentKeepDays: number
  /** One backup a day at this hour (site's time zone), kept this many days. */
  backupDaily: boolean
  backupDailyHour: number
  backupDailyKeepDays: number
  /** '' | 'failed' | 'overdue': the last alert sent about its backups. */
  backupAlert: string
  kind: SiteKind
  /** Apps only: owner/name of the GitHub repo, the branch, the Dockerfile in it. */
  appRepo: string
  appBranch: string
  appDockerfile: string
  /** Apps only: the port the app listens on and the page that says it is up. */
  appPort: number
  appHealthPath: string
  /** Apps only: a push to the branch builds and deploys it. */
  appAutoDeploy: boolean
  /** Apps only: run once in each new version before it starts (migrations); '' = none. */
  appPredeploy: string
  /** Image apps only: the image as asked for (docker.io/library/nginx:1.27); '' = built from GitHub. */
  appImageRef: string
  /** Apps only: false = no web address, only reachable inside its project. */
  appPublic: boolean
  /** The project it belongs to (every service has one). */
  projectId: number
  /** 1 = the server has it on its project's network; 0 = still to do; 2 = the server's clubctl is too old. */
  projectSynced: number
  /** Storage only: its buckets (what the server should have, plus the latest numbers). */
  s3Buckets: Bucket[]
  /** Postgres and storage: soft disk quota, and the latest numbers from the server. */
  pgQuotaMb: number
  pgSizeBytes: number | null
  pgConnections: number | null
  pgMaxConnections: number | null
  pgCheckedAt: string | null
  /** Postgres only: set read-only because it went over its quota. */
  pgReadOnly: boolean
  /** Postgres only: the last quota alert sent (0 none, 80, 100). */
  pgAlertLevel: number
  createdAt: string
  updatedAt: string
}

type ClubRow = {
  id: number; name: string; display_name: string; server_id: number; status: string; image: string
  modules: string; custom_domains: string; secrets_enc: string; extra_env: string; timezone: string
  memory_mb: number; owner_email: string; owner_name: string; notes: string; created_at: string; updated_at: string
  pinned: number; test_site: number
  backup_frequent_hours: number; backup_frequent_keep_days: number; backup_daily: number; backup_daily_hour: number; backup_daily_keep_days: number; backup_alert: string
  kind: string; app_repo: string; app_branch: string; app_dockerfile: string; app_port: number; app_health_path: string; app_auto_deploy: number
  app_predeploy: string; app_image_ref: string; app_public: number; project_id: number | null; project_synced: number
  pg_quota_mb: number; pg_size_bytes: number | null; pg_connections: number | null; pg_max_connections: number | null; pg_checked_at: string | null
  pg_read_only: number; pg_alert_level: number; s3_buckets?: string
}

function toClub(r: ClubRow): Club {
  let customDomains: string[] = []
  try { customDomains = JSON.parse(r.custom_domains) } catch { /* keep empty */ }
  let modules: unknown = []
  try { modules = JSON.parse(r.modules) } catch { /* keep empty */ }
  let buckets: unknown = []
  try { buckets = JSON.parse(r.s3_buckets || '[]') } catch { /* keep empty */ }
  return {
    id: r.id, name: r.name, displayName: r.display_name, serverId: r.server_id, status: r.status as ClubStatus,
    image: r.image, modules: Array.isArray(modules) ? modules.filter((m): m is string => typeof m === 'string') : [], customDomains,
    secrets: decryptJson<ClubSecrets>(r.secrets_enc, {}), extraEnv: r.extra_env, timezone: r.timezone,
    memoryMb: r.memory_mb, ownerEmail: r.owner_email, ownerName: r.owner_name, notes: r.notes,
    pinned: !!r.pinned, testSite: !!r.test_site,
    backupFrequentHours: r.backup_frequent_hours, backupFrequentKeepDays: r.backup_frequent_keep_days, backupDaily: !!r.backup_daily,
    backupDailyHour: r.backup_daily_hour, backupDailyKeepDays: r.backup_daily_keep_days, backupAlert: r.backup_alert, createdAt: r.created_at, updatedAt: r.updated_at,
    kind: r.kind || 'app', appRepo: r.app_repo, appBranch: r.app_branch, appDockerfile: r.app_dockerfile,
    appPort: r.app_port, appHealthPath: r.app_health_path, appAutoDeploy: !!r.app_auto_deploy,
    appPredeploy: r.app_predeploy ?? '', appImageRef: r.app_image_ref ?? '', appPublic: r.app_public !== 0, projectId: r.project_id ?? 0, projectSynced: r.project_synced ?? 0,
    pgQuotaMb: r.pg_quota_mb ?? 5120, pgSizeBytes: r.pg_size_bytes, pgConnections: r.pg_connections, pgMaxConnections: r.pg_max_connections,
    pgCheckedAt: r.pg_checked_at, pgReadOnly: !!r.pg_read_only, pgAlertLevel: r.pg_alert_level ?? 0,
    s3Buckets: Array.isArray(buckets) ? buckets.filter((b): b is Bucket => !!b && typeof b.name === 'string').map((b) => ({ name: b.name, public: !!b.public, objects: b.objects ?? null, bytes: b.bytes ?? null })) : [],
  }
}

export function listClubs(): Club[] {
  return (db().prepare('SELECT * FROM clubs ORDER BY name').all() as ClubRow[]).map(toClub)
}
export function getClub(id: number): Club | null {
  const r = db().prepare('SELECT * FROM clubs WHERE id = ?').get(id) as ClubRow | undefined
  return r ? toClub(r) : null
}
export function getClubByName(name: string): Club | null {
  const r = db().prepare('SELECT * FROM clubs WHERE name = ?').get(name) as ClubRow | undefined
  return r ? toClub(r) : null
}

type BackupFields = 'backupFrequentHours' | 'backupFrequentKeepDays' | 'backupDaily' | 'backupDailyHour' | 'backupDailyKeepDays' | 'backupAlert'
type AppFields = 'kind' | 'appRepo' | 'appBranch' | 'appDockerfile' | 'appPort' | 'appHealthPath' | 'appAutoDeploy' | 'appPredeploy' | 'appImageRef' | 'appPublic' | 'pgQuotaMb'
type ServiceFields = 'projectId' | 'projectSynced' | 'pgSizeBytes' | 'pgConnections' | 'pgMaxConnections' | 'pgCheckedAt' | 'pgReadOnly' | 'pgAlertLevel' | 's3Buckets'
export const isApp = (c: Pick<Club, 'kind'>) => c.kind === 'app'
export const isPostgres = (c: Pick<Club, 'kind'>) => c.kind === 'postgres'
export const isStorage = (c: Pick<Club, 'kind'>) => c.kind === 'minio'
/** Kinds the core runs itself (the rest come from plugins). */
export const isCoreKind = (kind: string) => kind === 'app' || kind === 'postgres' || kind === 'minio'
/** An app run from a ready-made image (Docker Hub…) rather than built from GitHub. */
export const isImageApp = (c: Pick<Club, 'kind' | 'appImageRef'>) => c.kind === 'app' && !!c.appImageRef
/** A site with a web address (an Avrosphere site, an app, storage given one); databases and internal apps have none. */
export const hasAddress = (c: Pick<Club, 'kind'> & Partial<Pick<Club, 'appPublic'>>) => c.kind !== 'postgres' && c.appPublic !== false
export function insertClub(c: Omit<Club, 'id' | 'createdAt' | 'updatedAt' | 'pinned' | 'testSite' | BackupFields | AppFields | ServiceFields> & { pinned?: boolean; testSite?: boolean; projectId?: number; createdBy?: string } & Partial<Pick<Club, BackupFields | AppFields | 's3Buckets'>>): Club {
  const t = now()
  // Every service lives in a project; without one it gets its own, named like it.
  const projectId = c.projectId || createProjectRow({ name: freeProjectName(c.name), displayName: c.displayName, serverId: c.serverId, createdBy: c.createdBy ?? '' })
  const info = db().prepare(
    `INSERT INTO clubs (name, display_name, server_id, status, image, modules, custom_domains, secrets_enc, extra_env, timezone, memory_mb, owner_email, owner_name, notes, project_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(c.name, c.displayName, c.serverId, c.status, c.image, JSON.stringify(c.modules), JSON.stringify(c.customDomains),
    encryptJson(c.secrets), c.extraEnv, c.timezone, c.memoryMb, c.ownerEmail, c.ownerName, c.notes, projectId, t, t)
  const id = Number(info.lastInsertRowid)
  // A plugin's kind (the column's default, 'avrosphere', is from before kinds were plugins).
  if (c.kind && c.kind !== 'app' && c.kind !== 'postgres' && c.kind !== 'minio') db().prepare('UPDATE clubs SET kind = ? WHERE id = ?').run(c.kind, id)
  if (c.kind === 'postgres' || c.kind === 'minio') {
    // A database or storage keeps its data on the server, so it gets the default backup schedule too.
    const d = getSettings()
    updateClub(id, {
      kind: c.kind, pgQuotaMb: c.pgQuotaMb ?? (c.kind === 'minio' ? 10240 : 5120),
      ...(c.kind === 'minio' ? { appPublic: c.appPublic ?? false, appPort: 9000, s3Buckets: c.s3Buckets ?? [] } : {}),
      backupFrequentHours: c.backupFrequentHours ?? d.backupDefaultFrequentHours, backupFrequentKeepDays: c.backupFrequentKeepDays ?? d.backupDefaultFrequentKeepDays,
      backupDaily: c.backupDaily ?? d.backupDefaultDaily, backupDailyHour: c.backupDailyHour ?? d.backupDefaultDailyHour, backupDailyKeepDays: c.backupDailyKeepDays ?? d.backupDefaultDailyKeepDays,
    })
    return getClub(id)!
  }
  if (c.pinned || c.testSite) db().prepare('UPDATE clubs SET pinned = ?, test_site = ? WHERE id = ?').run(c.pinned ? 1 : 0, c.testSite ? 1 : 0, id)
  if (c.kind === 'app') {
    updateClub(id, {
      kind: 'app', appRepo: c.appRepo ?? '', appBranch: c.appBranch ?? '', appDockerfile: c.appDockerfile || 'Dockerfile',
      appPort: c.appPort ?? 3000, appHealthPath: c.appHealthPath ?? '/', appAutoDeploy: c.appAutoDeploy ?? true, appPredeploy: c.appPredeploy ?? '',
      appImageRef: c.appImageRef ?? '', appPublic: c.appPublic ?? true,
      // Apps keep nothing on the server, so there is nothing to back up.
      backupFrequentHours: 0, backupDaily: false,
    })
    return getClub(id)!
  }
  // New sites start on the default backup schedule from Settings.
  const d = getSettings()
  updateClub(id, {
    backupFrequentHours: c.backupFrequentHours ?? d.backupDefaultFrequentHours, backupFrequentKeepDays: c.backupFrequentKeepDays ?? d.backupDefaultFrequentKeepDays,
    backupDaily: c.backupDaily ?? d.backupDefaultDaily, backupDailyHour: c.backupDailyHour ?? d.backupDefaultDailyHour, backupDailyKeepDays: c.backupDailyKeepDays ?? d.backupDefaultDailyKeepDays,
  })
  return getClub(id)!
}

export function updateClub(id: number, patch: Partial<Omit<Club, 'id' | 'name' | 'createdAt' | 'updatedAt'>>) {
  const map: Record<string, unknown> = {}
  if (patch.kind !== undefined) map.kind = patch.kind
  if (patch.appRepo !== undefined) map.app_repo = patch.appRepo
  if (patch.appBranch !== undefined) map.app_branch = patch.appBranch
  if (patch.appDockerfile !== undefined) map.app_dockerfile = patch.appDockerfile
  if (patch.appPort !== undefined) map.app_port = patch.appPort
  if (patch.appHealthPath !== undefined) map.app_health_path = patch.appHealthPath
  if (patch.appAutoDeploy !== undefined) map.app_auto_deploy = patch.appAutoDeploy ? 1 : 0
  if (patch.appPredeploy !== undefined) map.app_predeploy = patch.appPredeploy
  if (patch.appImageRef !== undefined) map.app_image_ref = patch.appImageRef
  if (patch.appPublic !== undefined) map.app_public = patch.appPublic ? 1 : 0
  if (patch.projectId !== undefined) map.project_id = patch.projectId
  if (patch.projectSynced !== undefined) map.project_synced = patch.projectSynced
  if (patch.pgQuotaMb !== undefined) map.pg_quota_mb = patch.pgQuotaMb
  if (patch.pgSizeBytes !== undefined) map.pg_size_bytes = patch.pgSizeBytes
  if (patch.pgConnections !== undefined) map.pg_connections = patch.pgConnections
  if (patch.pgMaxConnections !== undefined) map.pg_max_connections = patch.pgMaxConnections
  if (patch.pgCheckedAt !== undefined) map.pg_checked_at = patch.pgCheckedAt
  if (patch.pgReadOnly !== undefined) map.pg_read_only = patch.pgReadOnly ? 1 : 0
  if (patch.pgAlertLevel !== undefined) map.pg_alert_level = patch.pgAlertLevel
  if (patch.s3Buckets !== undefined) map.s3_buckets = JSON.stringify(patch.s3Buckets.map((b) => ({ name: b.name, public: b.public, objects: b.objects, bytes: b.bytes })))
  if (patch.displayName !== undefined) map.display_name = patch.displayName
  if (patch.serverId !== undefined) map.server_id = patch.serverId
  if (patch.status !== undefined) map.status = patch.status
  if (patch.image !== undefined) map.image = patch.image
  if (patch.modules !== undefined) map.modules = JSON.stringify(patch.modules)
  if (patch.customDomains !== undefined) map.custom_domains = JSON.stringify(patch.customDomains)
  if (patch.secrets !== undefined) map.secrets_enc = encryptJson(patch.secrets)
  if (patch.extraEnv !== undefined) map.extra_env = patch.extraEnv
  if (patch.timezone !== undefined) map.timezone = patch.timezone
  if (patch.memoryMb !== undefined) map.memory_mb = patch.memoryMb
  if (patch.ownerEmail !== undefined) map.owner_email = patch.ownerEmail
  if (patch.ownerName !== undefined) map.owner_name = patch.ownerName
  if (patch.notes !== undefined) map.notes = patch.notes
  if (patch.pinned !== undefined) map.pinned = patch.pinned ? 1 : 0
  if (patch.testSite !== undefined) map.test_site = patch.testSite ? 1 : 0
  if (patch.backupFrequentHours !== undefined) map.backup_frequent_hours = patch.backupFrequentHours
  if (patch.backupFrequentKeepDays !== undefined) map.backup_frequent_keep_days = patch.backupFrequentKeepDays
  if (patch.backupDaily !== undefined) map.backup_daily = patch.backupDaily ? 1 : 0
  if (patch.backupDailyHour !== undefined) map.backup_daily_hour = patch.backupDailyHour
  if (patch.backupDailyKeepDays !== undefined) map.backup_daily_keep_days = patch.backupDailyKeepDays
  if (patch.backupAlert !== undefined) map.backup_alert = patch.backupAlert
  map.updated_at = now()
  const cols = Object.keys(map)
  db().prepare(`UPDATE clubs SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => map[c]), id)
}

// ── Versions a site has run ──────────────────────────────────────────────────
export type ClubVersion = { id: number; image: string; by: string; at: string; note: string }

/** Called when a site starts on, or finishes moving to, an image. `note`: an app's commit message. */
export function recordClubVersion(clubId: number, image: string, by: string, note = '') {
  const last = db().prepare('SELECT image FROM club_versions WHERE club_id = ? ORDER BY id DESC LIMIT 1').get(clubId) as { image: string } | undefined
  if (last?.image === image) return
  db().prepare('INSERT INTO club_versions (club_id, image, by, at, note) VALUES (?, ?, ?, ?, ?)').run(clubId, image, by, now(), note.slice(0, 300))
}
export function listClubVersions(clubId: number, limit = 20): ClubVersion[] {
  return db().prepare('SELECT id, image, by, at, note FROM club_versions WHERE club_id = ? ORDER BY id DESC LIMIT ?').all(clubId, limit) as ClubVersion[]
}

export function deleteClubRow(id: number) {
  db().prepare('DELETE FROM clubs WHERE id = ?').run(id)
}

/** Custom domains already taken by another club. */
export function domainInUse(domain: string, exceptClubId?: number): boolean {
  return listClubs().some((c) => c.id !== exceptClubId && c.customDomains.includes(domain))
}

// ── Servers (clubs VMs) ──────────────────────────────────────────────────────
export function listServers(): ServerRow[] {
  return db().prepare('SELECT * FROM servers ORDER BY name').all() as ServerRow[]
}
export function getServer(id: number): ServerRow | null {
  return (db().prepare('SELECT * FROM servers WHERE id = ?').get(id) as ServerRow | undefined) ?? null
}
/** Sites and apps on a server (databases and storage don't use up a site place). */
export function clubCount(serverId: number): number {
  return (db().prepare("SELECT COUNT(*) AS n FROM clubs WHERE server_id = ? AND kind NOT IN ('postgres', 'minio')").get(serverId) as { n: number }).n
}
/** Memory limits of every service on a server, MB. */
export function memoryUsed(serverId: number): number {
  return (db().prepare('SELECT COALESCE(SUM(memory_mb), 0) AS n FROM clubs WHERE server_id = ?').get(serverId) as { n: number }).n
}
/** Kept for the shared Postgres, Caddy and the system on every sites VM. */
export const SERVER_RESERVED_MB = 1024
/** What a server keeps for itself: 1 GB, or 384 MB on a 1 GB server (apps only, so its shared Postgres stays idle). */
export const reservedMb = (server: Pick<ServerRow, 'memory_mb'>) => ((server.memory_mb ?? 0) > 0 && (server.memory_mb ?? 0) <= 1024 ? 384 : SERVER_RESERVED_MB)
/**
 * Why a server can't take another service of this size, or null when it can.
 * Memory counts when the server's memory is known; the site places cap sites and apps.
 */
export function serverRoomError(server: ServerRow, add: { memoryMb: number; site: boolean }): string | null {
  if (add.site && clubCount(server.id) >= server.max_clubs) return `${server.name} is full (${server.max_clubs} site places). Raise its limit under Servers or pick another server.`
  const total = server.memory_mb ?? 0
  if (total > 0) {
    const free = total - reservedMb(server) - memoryUsed(server.id)
    if (add.memoryMb > free) return `${server.name} has ${Math.max(0, free)} MB of memory left for services, and this needs ${add.memoryMb} MB. Lower the memory, free some up, or pick another server.`
  }
  return null
}
/**
 * The server with the most free places that still takes new clubs, or null when all are full.
 * Small apps-only servers are only picked for apps.
 */
export function pickServer(opts: { forApps?: boolean } = {}): ServerRow | null {
  let best: ServerRow | null = null
  let bestFree = 0
  for (const s of listServers()) {
    if (!s.accepts_new) continue
    if (s.purpose === 'apps' && !opts.forApps) continue
    const free = s.max_clubs - clubCount(s.id)
    if (free > bestFree) { best = s; bestFree = free }
  }
  return best
}
export function saveServer(s: { id?: number; name: string; host: string; port: number; username: string; hostKey: string; publicIp: string; maxClubs: number; acceptsNew: boolean; memoryMb?: number }): number {
  if (s.id) {
    db().prepare('UPDATE servers SET name = ?, host = ?, port = ?, username = ?, host_key = ?, public_ip = ?, max_clubs = ?, accepts_new = ?, memory_mb = ? WHERE id = ?')
      .run(s.name, s.host, s.port, s.username, s.hostKey, s.publicIp, s.maxClubs, s.acceptsNew ? 1 : 0, s.memoryMb ?? 0, s.id)
    return s.id
  }
  const info = db().prepare('INSERT INTO servers (name, host, port, username, host_key, public_ip, max_clubs, accepts_new, memory_mb, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(s.name, s.host, s.port, s.username, s.hostKey, s.publicIp, s.maxClubs, s.acceptsNew ? 1 : 0, s.memoryMb ?? 0, now())
  return Number(info.lastInsertRowid)
}
export function deleteServer(id: number): string | null {
  if ((db().prepare('SELECT COUNT(*) AS n FROM clubs WHERE server_id = ?').get(id) as { n: number }).n > 0) return 'Move or remove its sites first.'
  if ((db().prepare('SELECT COUNT(*) AS n FROM projects WHERE server_id = ?').get(id) as { n: number }).n > 0) return 'Remove its projects first.'
  db().prepare('DELETE FROM servers WHERE id = ?').run(id)
  return null
}

/** A free name close to the one asked for (shop → shop-2, shop-site…), or '' when none of the tries is free. */
export function freeNameLike(name: string): string {
  const base = name.replace(/[^a-z0-9-]/g, '').replace(/-+$/, '').slice(0, 25) || 'site'
  const tries = [`${base}-site`, `${base}-app`, ...Array.from({ length: 8 }, (_, i) => `${base}-${i + 2}`)]
  return tries.find((n) => !clubNameError(n) && !getClubByName(n)) ?? ''
}

/**
 * Why a new site, app or service can't have this name (badly formed, kept for
 * the platform, or already used), with a free name to try; null when it is fine.
 */
export function newNameError(name: string): string | null {
  const bad = clubNameError(name)
  const taken = bad ? null : getClubByName(name)
  if (!bad && !taken) return null
  const why = taken ? `"${name}" is already used by ${taken.displayName && taken.displayName !== name ? `${taken.displayName} (${name})` : name}.` : bad!
  const free = /^[a-z]/.test(name) ? freeNameLike(name) : ''
  return free && !why.startsWith('Use ') ? `${why} Try ${free} instead.` : why
}
