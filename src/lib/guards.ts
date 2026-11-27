import { notFound } from 'next/navigation'
import { type Admin, requireAdmin } from './auth'
import { type SiteLevel, canBuildInProject, canSeeProject, canSite, isOwner } from './access'
import { type Club, getClub } from './clubs'
import { type Project, getProject, serviceIds } from './projects'
import { type PluginId, hiddenByPlugin, pluginOn } from '@/plugins'

// The checks pages, server actions and API routes call. The rules themselves
// live in lib/access.ts. Anything a person isn't allowed to reach answers
// "not found", so a viewer can't even tell which other sites exist.

/** Owners only: servers, settings, costs, releases, people, the bucket, creating and removing sites. */
export async function requireOwner(): Promise<Admin> {
  const admin = await requireAdmin()
  if (!isOwner(admin)) notFound()
  return admin
}

/** One site, at the level the page or action needs. */
export async function requireSite(clubId: number, level: SiteLevel): Promise<{ admin: Admin; club: Club }> {
  const admin = await requireAdmin()
  const club = Number.isInteger(clubId) && clubId > 0 ? getClub(clubId) : null
  if (!club || !canSite(admin, club.id, level) || hiddenByPlugin(club)) notFound()
  return { admin, club }
}

/** For server actions that shouldn't throw: the site, or null when it's gone or not theirs. */
export async function siteFor(clubId: number, level: SiteLevel): Promise<{ admin: Admin; club: Club } | null> {
  const admin = await requireAdmin()
  const club = Number.isInteger(clubId) && clubId > 0 ? getClub(clubId) : null
  return club && canSite(admin, club.id, level) && !hiddenByPlugin(club) ? { admin, club } : null
}

/** One project, for its page: the project and the ids of its services. 404 when it's gone or not theirs. */
export async function requireProject(projectId: number, level: 'view' | 'build'): Promise<{ admin: Admin; project: Project }> {
  const admin = await requireAdmin()
  const project = Number.isInteger(projectId) && projectId > 0 ? getProject(projectId) : null
  if (!project) notFound()
  const ok = level === 'build' ? canBuildInProject(admin, project.id) : canSeeProject(admin, project.id, serviceIds(project.id))
  if (!ok) notFound()
  return { admin, project }
}

/** For server actions that shouldn't throw: the project, or null when it's gone or not theirs. */
export async function projectFor(projectId: number, level: 'view' | 'build'): Promise<{ admin: Admin; project: Project } | null> {
  const admin = await requireAdmin()
  const project = Number.isInteger(projectId) && projectId > 0 ? getProject(projectId) : null
  if (!project) return null
  const ok = level === 'build' ? canBuildInProject(admin, project.id) : canSeeProject(admin, project.id, serviceIds(project.id))
  return ok ? { admin, project } : null
}

/** Pages that belong to a plugin answer "not found" while it's off. */
export function requirePlugin(id: PluginId): void {
  if (!pluginOn(id)) notFound()
}

/** The same, for server actions that report instead of throwing: the reason, or null when the plugin is on. */
export function pluginOffError(id: PluginId): string | null {
  return pluginOn(id) ? null : 'That part of the deployer is turned off under Settings › Plugins.'
}
