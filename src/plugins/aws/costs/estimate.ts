import { listClubs, listServers } from '@/lib/clubs'
import { bucketUsage, clubNs } from '@/lib/backups/records'
import { listProjects } from '@/lib/projects'
import { allocate, allocateProjects, type Allocation, type ProjectCost } from './report'
import { latestSnapshot } from './service'

/** This month's estimate per service and per project, from the last cost snapshot; null before the first one. */
export function currentEstimate(): { alloc: Allocation; projects: ProjectCost[] } | null {
  const snap = latestSnapshot()
  if (!snap) return null
  const usage = bucketUsage()
  const clubs = listClubs().filter((c) => c.status !== 'removing')
  const alloc = allocate(
    clubs.map((c) => ({ id: c.id, name: c.name, displayName: c.displayName, serverId: c.serverId, memoryMb: c.memoryMb, running: c.status === 'running', bucketBytes: usage.byNs.get(clubNs(c)) ?? 0 })),
    listServers().map((v) => ({ id: v.id, name: v.name, host: v.host, publicIp: v.public_ip })),
    snap.resources, snap.rate,
  )
  const projectOf = new Map(clubs.map((c) => [c.id, c.projectId || null]))
  const running = new Set(clubs.filter((c) => c.status === 'running').map((c) => c.id))
  const projects = allocateProjects(alloc, listProjects().map((p) => ({ id: p.id, name: p.displayName })), (id) => projectOf.get(id) ?? null, running, snap.rate)
  return { alloc, projects }
}
