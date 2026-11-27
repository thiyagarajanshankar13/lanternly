import { db, now } from './db'

// Projects: a named group of services (Avrosphere sites, apps, PostgreSQL
// databases) on one server. On the server each project is a Docker network,
// proj-<name>, that only its services and Caddy join, so services reach each
// other by name and nothing in another project can reach them.
//
// This file only touches the projects and service_links tables (clubs.ts
// imports it), plus the pure rules for links, references and databases.

export type Project = {
  id: number
  name: string
  displayName: string
  serverId: number
  description: string
  createdBy: string
  createdAt: string
}
type ProjectRow = { id: number; name: string; display_name: string; server_id: number; description: string; created_by: string; created_at: string }
const toProject = (r: ProjectRow): Project => ({
  id: r.id, name: r.name, displayName: r.display_name, serverId: r.server_id, description: r.description, createdBy: r.created_by, createdAt: r.created_at,
})

export function listProjects(): Project[] {
  return (db().prepare('SELECT * FROM projects ORDER BY display_name COLLATE NOCASE, name').all() as ProjectRow[]).map(toProject)
}
export function getProject(id: number): Project | null {
  const r = db().prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined
  return r ? toProject(r) : null
}
export function getProjectByName(name: string): Project | null {
  const r = db().prepare('SELECT * FROM projects WHERE name = ?').get(name) as ProjectRow | undefined
  return r ? toProject(r) : null
}

/** `base`, or base-2, base-3… when a project already has that name. */
export function freeProjectName(base: string): string {
  const clean = base.slice(0, 28).replace(/-+$/, '') || 'project'
  if (!getProjectByName(clean)) return clean
  for (let i = 2; i < 1000; i++) if (!getProjectByName(`${clean}-${i}`)) return `${clean}-${i}`
  return `${clean}-${Date.now().toString(36)}`
}

export function createProjectRow(p: { name: string; displayName: string; serverId: number; description?: string; createdBy?: string }): number {
  const info = db().prepare('INSERT INTO projects (name, display_name, server_id, description, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(p.name, p.displayName || p.name, p.serverId, (p.description ?? '').slice(0, 500), p.createdBy ?? '', now())
  return Number(info.lastInsertRowid)
}
export function updateProject(id: number, patch: { displayName?: string; description?: string }) {
  if (patch.displayName !== undefined) db().prepare('UPDATE projects SET display_name = ? WHERE id = ?').run(patch.displayName, id)
  if (patch.description !== undefined) db().prepare('UPDATE projects SET description = ? WHERE id = ?').run(patch.description.slice(0, 500), id)
}
/** The ids of the services in a project. */
export function serviceIds(projectId: number): number[] {
  return (db().prepare('SELECT id FROM clubs WHERE project_id = ? ORDER BY name').all(projectId) as { id: number }[]).map((r) => r.id)
}
/** Removes an empty project; a project with services says so instead. */
export function deleteProject(id: number): string | null {
  if (serviceIds(id).length) return 'Remove or move its services first.'
  db().prepare('DELETE FROM projects WHERE id = ?').run(id)
  return null
}

// ── Links: which databases (and storage) an app gets the variables of ───────
/** dbId is the database's or storage's id; bucket is only used for storage ('' = its first bucket). */
export type Link = { appId: number; dbId: number; prefix: string; bucket: string }
type LinkRow = { app_id: number; db_id: number; prefix: string; bucket: string }
const toLink = (r: LinkRow): Link => ({ appId: r.app_id, dbId: r.db_id, prefix: r.prefix, bucket: r.bucket ?? '' })

export function linksOfApp(appId: number): Link[] {
  return (db().prepare('SELECT app_id, db_id, prefix, bucket FROM service_links WHERE app_id = ? ORDER BY prefix, db_id').all(appId) as LinkRow[]).map(toLink)
}
export function linksToDb(dbId: number): Link[] {
  return (db().prepare('SELECT app_id, db_id, prefix, bucket FROM service_links WHERE db_id = ? ORDER BY app_id').all(dbId) as LinkRow[]).map(toLink)
}
export function setLinks(appId: number, links: { dbId: number; prefix: string; bucket?: string }[]) {
  db().transaction(() => {
    db().prepare('DELETE FROM service_links WHERE app_id = ?').run(appId)
    const add = db().prepare('INSERT OR REPLACE INTO service_links (app_id, db_id, prefix, bucket) VALUES (?, ?, ?, ?)')
    for (const l of links) add.run(appId, l.dbId, l.prefix, l.bucket ?? '')
  })()
}
/** Points links at a bucket that is gone back to the storage's first bucket. */
export function clearBucketLinks(storageId: number, bucket: string) {
  db().prepare('UPDATE service_links SET bucket = ? WHERE db_id = ? AND bucket = ?').run('', storageId, bucket)
}

// ── Pure rules ───────────────────────────────────────────────────────────────

/** The variables a connected app gets from a database (each with the link's prefix in front). */
export const PG_VARS = ['DATABASE_URL', 'PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE'] as const
export type PgVar = (typeof PG_VARS)[number]

/** Database user and database name on the server: the service name with _ for -. */
export const pgIdent = (name: string) => name.replace(/-/g, '_')

/** What an app sees, with the password hidden (the real one is filled in on the server). */
export function pgVarsShown(dbName: string, prefix = ''): { key: string; value: string }[] {
  const user = pgIdent(dbName)
  return [
    { key: `${prefix}DATABASE_URL`, value: `postgresql://${user}:••••@${dbName}:5432/${user}` },
    { key: `${prefix}PGHOST`, value: dbName },
    { key: `${prefix}PGPORT`, value: '5432' },
    { key: `${prefix}PGUSER`, value: user },
    { key: `${prefix}PGPASSWORD`, value: '•••• (made on the server)' },
    { key: `${prefix}PGDATABASE`, value: user },
  ]
}

/** A prefix is blank or capitals/digits/_ ending in _, like ANALYTICS_. */
export function prefixError(prefix: string): string | null {
  if (!prefix) return null
  return /^[A-Z][A-Z0-9_]{0,30}_$/.test(prefix) ? null : 'A prefix is capital letters, digits and _, ending in _ (for example ANALYTICS_).'
}

/** Two links that would give the app the same variable names (a database and a storage never clash: their names differ). */
export function linksClash(links: { prefix: string; storage?: boolean }[]): string | null {
  const seen = new Set<string>()
  for (const l of links) {
    const key = `${l.storage ? 's3' : 'pg'}:${l.prefix}`
    if (seen.has(key)) {
      if (l.storage) return l.prefix ? `Two storages use the prefix ${l.prefix}.` : 'Two storages have no prefix, so they would set the same S3_ENDPOINT. Give one a prefix such as MEDIA_.'
      return l.prefix ? `Two databases use the prefix ${l.prefix}.` : 'Two databases have no prefix, so they would set the same DATABASE_URL. Give one a prefix such as ANALYTICS_.'
    }
    seen.add(key)
  }
  return null
}

const REF = /\$\{\{\s*([a-z][a-z0-9-]{0,40})\.([A-Z0-9_]+)\s*\}\}/g

/** Every ${{service.VAR}} in a block of settings. */
export function parseRefs(text: string): { service: string; variable: string }[] {
  return [...text.matchAll(REF)].map((m) => ({ service: m[1], variable: m[2] }))
}

/** Checks the references in an app's settings against the databases (and storage) in its project. */
export function refsError(text: string, databasesInProject: string[], storageInProject: string[] = []): string | null {
  if (/\$\{\{/.test(text.replace(REF, ''))) return 'A reference looks like ${{database.VARIABLE}}, for example ${{shop-db.DATABASE_URL}}.'
  for (const r of parseRefs(text)) {
    if (storageInProject.includes(r.service)) {
      if (!(S3_VARS as readonly string[]).includes(r.variable)) return `\${{${r.service}.${r.variable}}}: a storage has ${S3_VARS.join(', ')}.`
      continue
    }
    if (!databasesInProject.includes(r.service)) return `\${{${r.service}.${r.variable}}}: there is no ${storageInProject.length ? 'database or storage' : 'database'} called ${r.service} in this project.`
    if (!(PG_VARS as readonly string[]).includes(r.variable)) return `\${{${r.service}.${r.variable}}}: a database has ${PG_VARS.join(', ')}.`
  }
  return null
}

/** The databases an app's settings refer to, by name. */
export const referencedDatabases = (text: string) => [...new Set(parseRefs(text).map((r) => r.service))]

/** A pre-deploy command: one line, shell syntax, run in the new image. */
export function predeployError(cmd: string): string | null {
  if (!cmd) return null
  if (cmd.length > 500) return 'Keep the pre-deploy command under 500 characters.'
  if (/[\r\n]/.test(cmd)) return 'The pre-deploy command must be one line (join steps with &&).'
  return null
}

export const PG_VERSIONS = ['16', '17'] as const
export const PG_DEFAULT_VERSION = '16'
export const pgImage = (version: string) => `postgres:${version}`
/** "16" from postgres:16 (or postgres:16.4). */
export function pgVersionOf(image: string): string {
  const m = /^postgres:(\d+)/.exec(image)
  return m ? m[1] : ''
}
export const PG_MEMORY_MIN = 128
export const PG_MEMORY_MAX = 4096
export const PG_QUOTA_MIN = 256
export const PG_QUOTA_MAX = 200_000

/** Postgres settings sized to the container's memory (clubctl uses the same sums). */
export function pgTuning(memoryMb: number): { sharedBuffersMb: number; maxConnections: number } {
  return { sharedBuffersMb: Math.max(16, Math.floor(memoryMb / 4)), maxConnections: Math.min(200, Math.max(20, Math.floor(memoryMb / 6))) }
}

// ── S3 storage (MinIO) ───────────────────────────────────────────────────────

/** The variables a connected app gets from a storage (each with the link's prefix in front). */
export const S3_VARS = ['S3_ENDPOINT', 'S3_PUBLIC_URL', 'S3_REGION', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_FORCE_PATH_STYLE'] as const
/** With no prefix the app also gets these, which AWS SDKs read by themselves. */
export const S3_AWS_VARS = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_ENDPOINT_URL_S3'] as const
export const S3_REGION = 'us-east-1'
/** MinIO stopped publishing its own images in 2025; Chainguard's build is free and kept patched. Pinned to a digest at create. */
export const S3_DEFAULT_IMAGE = 'docker.io/chainguard/minio:latest'
export const S3_MEMORY_MIN = 128
export const S3_MEMORY_MAX = 4096
export const S3_QUOTA_MIN = 1024
export const S3_QUOTA_MAX = 2_000_000
export const S3_MAX_BUCKETS = 20

/** What an app sees, with the secret hidden (the real one is filled in on the server). */
export function s3VarsShown(name: string, opts: { prefix?: string; bucket?: string; publicUrl?: string | null } = {}): { key: string; value: string }[] {
  const p = opts.prefix ?? ''
  const endpoint = `http://${name}:9000`
  const rows = [
    { key: `${p}S3_ENDPOINT`, value: endpoint },
    { key: `${p}S3_PUBLIC_URL`, value: opts.publicUrl || endpoint },
    { key: `${p}S3_REGION`, value: S3_REGION },
    { key: `${p}S3_BUCKET`, value: opts.bucket || '(its first bucket)' },
    { key: `${p}S3_ACCESS_KEY_ID`, value: `${name}-app` },
    { key: `${p}S3_SECRET_ACCESS_KEY`, value: '•••• (made on the server)' },
    { key: `${p}S3_FORCE_PATH_STYLE`, value: 'true' },
  ]
  if (!p) rows.push({ key: 'AWS_*', value: `AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, AWS_DEFAULT_REGION, AWS_ENDPOINT_URL_S3 (the same values)` })
  return rows
}

/** S3 bucket names here: 3–63 lowercase letters, digits and hyphens (no dots, so they work in every client). */
export function bucketNameError(name: string): string | null {
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(name)) return 'A bucket name is 3 to 63 lowercase letters, digits and hyphens, starting and ending with a letter or digit.'
  if (name.includes('--')) return 'A bucket name has no double hyphens.'
  if (/^xn--|^sthree-|-s3alias$|--ol-s3$/.test(name)) return 'That bucket name is reserved in S3.'
  return null
}

/** Quota level reached: 0, 80 or 100 (percent). */
export function quotaLevel(bytes: number | null, quotaMb: number): 0 | 80 | 100 {
  if (bytes === null || quotaMb <= 0) return 0
  const pct = (bytes / (quotaMb * 1024 * 1024)) * 100
  return pct >= 100 ? 100 : pct >= 80 ? 80 : 0
}
