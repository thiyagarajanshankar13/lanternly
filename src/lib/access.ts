// Who may do what in the deployer. Pure: no database, no Next.js, so pages,
// server actions, API routes and tests all use the same rules.
//
// Three roles. Owners do everything. Operators and viewers only ever see the
// sites on their list (every site, or the ones picked for them): operators
// can run and change those sites, viewers can only look (status, monitoring,
// deploy output and logs). Anything that isn't about one site (servers,
// settings, costs, releases, people, the bucket) is for owners only.

export type Role = 'owner' | 'operator' | 'viewer'

export const ROLES: { value: Role; label: string; help: string }[] = [
  { value: 'owner', label: 'Owner', help: 'Everything: every site, servers, settings, costs, releases and people.' },
  { value: 'operator', label: 'Operator', help: 'Runs the sites on their list: deploy, restart, pause, settings, domains, back up.' },
  { value: 'viewer', label: 'Viewer', help: 'Watches the sites on their list: status, monitoring, deploy output and logs. Changes nothing.' },
]

export const roleLabel = (role: Role) => ROLES.find((r) => r.value === role)?.label ?? role
export const isRole = (v: unknown): v is Role => v === 'owner' || v === 'operator' || v === 'viewer'

/**
 * The part of a signed-in person that decides what they can reach.
 * siteIds are sites picked one by one; projectIds are whole projects, and
 * projectSiteIds the services in those projects (filled in when they sign in).
 */
export type Access = { role: Role; allSites: boolean; siteIds: number[]; projectIds?: number[]; projectSiteIds?: number[] }

/** A site the person can't see doesn't exist for them (lists leave it out, its pages 404). */
export type SiteLevel = 'view' | 'operate'

export const isOwner = (p: Access) => p.role === 'owner'

export function canSeeSite(p: Access, clubId: number | null | undefined): boolean {
  if (p.role === 'owner') return true
  if (clubId === null || clubId === undefined) return false
  return p.allSites || p.siteIds.includes(clubId) || (p.projectSiteIds ?? []).includes(clubId)
}

/** A project's page: owners, everyone with all sites or the project, and anyone who can see one of its services. */
export function canSeeProject(p: Access, projectId: number, serviceIds: number[] = []): boolean {
  if (p.role === 'owner' || p.allSites) return true
  if ((p.projectIds ?? []).includes(projectId)) return true
  return serviceIds.some((id) => canSeeSite(p, id))
}

/** Adding services to a project (databases, apps): owners, and operators given the whole project (or all sites). */
export function canBuildInProject(p: Access, projectId: number): boolean {
  if (p.role === 'owner') return true
  return p.role === 'operator' && (p.allSites || (p.projectIds ?? []).includes(projectId))
}

export function canOperateSite(p: Access, clubId: number | null | undefined): boolean {
  return (p.role === 'owner' || p.role === 'operator') && canSeeSite(p, clubId)
}

export function canSite(p: Access, clubId: number | null | undefined, level: SiteLevel): boolean {
  return level === 'operate' ? canOperateSite(p, clubId) : canSeeSite(p, clubId)
}

/** Keeps only the rows whose site the person can see. */
export function visibleTo<T>(p: Access, rows: T[], clubIdOf: (row: T) => number | null | undefined): T[] {
  if (p.role === 'owner') return rows
  return rows.filter((r) => canSeeSite(p, clubIdOf(r)))
}

/** Every page in the side menu. */
/** The core's side-menu pages. Plugins add their own (owners only), see src/plugins. */
export const CONSOLE_PAGES = [
  '/admin/projects', '/admin/services', '/admin/monitor', '/admin/backups', '/admin/activity',
  '/admin/people', '/admin/servers', '/admin/settings', '/admin/account',
]
const SITE_PAGES = ['/admin/projects', '/admin/services', '/admin/monitor', '/admin/activity', '/admin/account']

/** The side menu pages each role gets. Everything else is for owners. */
export function canUsePage(p: Access, href: string): boolean {
  return p.role === 'owner' || SITE_PAGES.includes(href)
}
export const pagesFor = (p: Access) => CONSOLE_PAGES.filter((href) => canUsePage(p, href))

/** Where signing in (and opening /admin) lands: Projects, else the first menu page this person can open. */
export const homePage = (p: Access): string => pagesFor(p)[0] ?? '/admin/account'

/** "Viewer · 3 sites", for the top bar. */
export function accessChip(p: Access): string {
  if (p.role === 'owner') return 'Owner'
  const projects = p.projectIds?.length ?? 0
  const parts = [projects ? `${projects} project${projects === 1 ? '' : 's'}` : '', p.siteIds.length ? `${p.siteIds.length} site${p.siteIds.length === 1 ? '' : 's'}` : '']
  const sites = p.allSites ? 'all sites' : parts.filter(Boolean).join(' + ') || '0 sites'
  return `${roleLabel(p.role)} · ${sites}`
}

function list(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  if (names.length <= 3) return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} other sites`
}

/** A plain-English line for the People page: what this person can and can't do. */
export function accessSummary(p: Access, siteName: (id: number) => string | undefined, projectName: (id: number) => string | undefined = () => undefined): string {
  if (p.role === 'owner') return 'Can do everything, including people, servers, settings and costs.'
  const projects = (p.projectIds ?? []).map(projectName).filter((n): n is string => !!n).map((n) => `project ${n}`)
  const names = [...projects, ...p.siteIds.map(siteName).filter((n): n is string => !!n)]
  const sites = p.allSites ? 'every site (including new ones)' : names.length ? list(names) : 'no sites yet'
  if (p.role === 'operator') {
    const build = p.allSites || projects.length ? ' Can add databases and apps to their projects.' : ''
    return `Can run and change ${sites}: deploy, restart, settings, domains and backups.${build} Can't remove sites.`
  }
  return `Can read the status, monitoring and logs of ${sites}. Can't change anything.`
}

/** The most an owner may hand out: anything, but the last owner must stay an owner. */
export function lastOwnerError(owners: number, target: { role: Role; suspended?: boolean }, next: { role?: Role; suspended?: boolean; removed?: boolean }): string | null {
  if (target.role !== 'owner' || target.suspended) return null
  const stillOwner = !next.removed && !next.suspended && (next.role ?? target.role) === 'owner'
  return !stillOwner && owners <= 1 ? 'There has to be at least one owner. Make someone else an owner first.' : null
}

// ── Masking secrets in logs ──────────────────────────────────────────────────

const SECRET_NAME = /(SECRET|TOKEN|PASS|PASSWORD|PWD|KEY|PRIVATE|CREDENTIAL|DSN|DATABASE_URI|DATABASE_URL)/i

/** Values worth hiding in this site's logs: its saved secrets, and env values with secret-looking names. */
export function secretValues(club: { secrets: Record<string, unknown>; extraEnv: string }): string[] {
  const out: string[] = []
  const s = club.secrets as { squareAccessToken?: string; squareWebhookSignatureKey?: string; assistKey?: string; appSecretEnv?: Record<string, string>; registryToken?: string }
  for (const v of [s.squareAccessToken, s.squareWebhookSignatureKey, s.assistKey]) if (v) out.push(v)
  for (const v of Object.values(s.appSecretEnv ?? {})) if (v) out.push(v)
  if (s.registryToken) out.push(s.registryToken)
  for (const line of club.extraEnv.split('\n')) {
    const at = line.indexOf('=')
    if (at < 1 || line.trimStart().startsWith('#')) continue
    const key = line.slice(0, at).trim()
    const value = line.slice(at + 1).trim().replace(/^(['"])(.*)\1$/, '$2')
    if (SECRET_NAME.test(key) && value) out.push(value)
  }
  // Short values (a "1", "true") would blank out half the log: only mask real secrets.
  return [...new Set(out.filter((v) => v.length >= 6))].sort((a, b) => b.length - a.length)
}

/** Replaces every known secret value, and anything after a password-ish "KEY=" in the text, with dots. */
export function maskSecrets(text: string, values: string[]): string {
  let out = text
  for (const v of values) out = out.split(v).join('••••')
  // Generic: "SOME_SECRET=abc123" / "password: hunter22" printed by an app.
  out = out.replace(/\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*)(\s*[=:]\s*)(["']?)([^\s"']{6,})\3/gi, '$1$2$3••••$3')
  return out
}
