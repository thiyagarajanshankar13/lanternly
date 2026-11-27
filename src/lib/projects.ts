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

// ── Links: which databases an app gets the variables of ─────────────────────
export type Link = { appId: number; dbId: number; prefix: string }

export function linksOfApp(appId: number): Link[] {
  return (db().prepare('SELECT app_id, db_id, prefix FROM service_links WHERE app_id = ? ORDER BY prefix, db_id').all(appId) as { app_id: number; db_id: number; prefix: string }[])
    .map((r) => ({ appId: r.app_id, dbId: r.db_id, prefix: r.prefix }))
}
export function linksToDb(dbId: number): Link[] {
  return (db().prepare('SELECT app_id, db_id, prefix FROM service_links WHERE db_id = ? ORDER BY app_id').all(dbId) as { app_id: number; db_id: number; prefix: string }[])
    .map((r) => ({ appId: r.app_id, dbId: r.db_id, prefix: r.prefix }))
}
export function setLinks(appId: number, links: { dbId: number; prefix: string }[]) {
  db().transaction(() => {
    db().prepare('DELETE FROM service_links WHERE app_id = ?').run(appId)
    const add = db().prepare('INSERT OR REPLACE INTO service_links (app_id, db_id, prefix) VALUES (?, ?, ?)')
    for (const l of links) add.run(appId, l.dbId, l.prefix)
  })()
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

/** Two links that would give the app the same variable names. */
export function linksClash(links: { prefix: string }[]): string | null {
  const seen = new Set<string>()
  for (const l of links) {
    if (seen.has(l.prefix)) return l.prefix ? `Two databases use the prefix ${l.prefix}.` : 'Two databases have no prefix, so they would set the same DATABASE_URL. Give one a prefix such as ANALYTICS_.'
    seen.add(l.prefix)
  }
  return null
}

const REF = /\$\{\{\s*([a-z][a-z0-9-]{0,40})\.([A-Z_]+)\s*\}\}/g

/** Every ${{service.VAR}} in a block of settings. */
export function parseRefs(text: string): { service: string; variable: string }[] {
  return [...text.matchAll(REF)].map((m) => ({ service: m[1], variable: m[2] }))
}

/** Checks the references in an app's settings against the databases in its project. */
export function refsError(text: string, databasesInProject: string[]): string | null {
  if (/\$\{\{/.test(text.replace(REF, ''))) return 'A reference looks like ${{database.VARIABLE}}, for example ${{shop-db.DATABASE_URL}}.'
  for (const r of parseRefs(text)) {
    if (!databasesInProject.includes(r.service)) return `\${{${r.service}.${r.variable}}}: there is no database called ${r.service} in this project.`
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

/** Quota level reached: 0, 80 or 100 (percent). */
export function quotaLevel(bytes: number | null, quotaMb: number): 0 | 80 | 100 {
  if (bytes === null || quotaMb <= 0) return 0
  const pct = (bytes / (quotaMb * 1024 * 1024)) * 100
  return pct >= 100 ? 100 : pct >= 80 ? 80 : 0
}
