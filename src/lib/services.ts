import { getClub, listClubs, type Club } from './clubs'
import { pluginForKind } from '@/plugins'
import { getProject, linksOfApp, linksToDb, type Project } from './projects'

// What the deployer tells clubctl about a service's place in its project:
// the project (its network), and for apps the databases they are connected
// to and the pre-deploy command. Passwords are never sent: clubctl fills in
// DATABASE_URL and the PG* variables from the database's own files.

export function projectOf(club: Pick<Club, 'projectId'>): Project | null {
  return club.projectId ? getProject(club.projectId) : null
}

/** The services in a project, sorted: sites and apps first, then databases. */
export function servicesOf(projectId: number): Club[] {
  const order = (kind: string) => (kind === 'postgres' ? 2 : kind === 'app' ? 1 : 0)
  return listClubs().filter((c) => c.projectId === projectId).sort((a, b) => order(a.kind) - order(b.kind) || a.name.localeCompare(b.name))
}

/** Database names in a project (what ${{name.VAR}} may point at). */
export function databasesIn(projectId: number): Club[] {
  return servicesOf(projectId).filter((c) => c.kind === 'postgres')
}

/** The CLUBCTL_ lines every service's settings carry. */
export function serviceLines(club: Club): string[] {
  const project = projectOf(club)
  const lines = project ? [`CLUBCTL_PROJECT=${project.name}`] : []
  if (club.kind === 'app') {
    for (const link of linksOfApp(club.id)) {
      const target = getClub(link.dbId)
      if (target && target.kind === 'postgres' && target.projectId === club.projectId) lines.push(`CLUBCTL_LINK=${target.name}:${link.prefix}`)
    }
    lines.push(`CLUBCTL_PREDEPLOY_B64=${club.appPredeploy ? Buffer.from(club.appPredeploy, 'utf8').toString('base64') : ''}`)
  }
  return lines
}

export const serviceText = (club: Club) => serviceLines(club).map((l) => `${l}\n`).join('')

/** Running or paused apps connected to a database (they restart when its password or data changes). */
export function appsUsing(dbId: number): Club[] {
  const db = getClub(dbId)
  const linked = new Set(linksToDb(dbId).map((l) => l.appId))
  return listClubs().filter((c) => c.kind === 'app' && (linked.has(c.id) || (db ? c.extraEnv.includes(`\${{${db.name}.`) : false)))
}

/** How each kind of service is named on screen. */
export const kindLabel = (kind: Club['kind']): string =>
  kind === 'app' ? 'App' : kind === 'postgres' ? 'PostgreSQL' : pluginForKind(kind)?.newService?.title ?? kind
