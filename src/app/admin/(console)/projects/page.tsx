import Link from 'next/link'
import { requireAdmin } from '@/lib/auth'
import { canBuildInProject, canSeeProject, canSeeSite, isOwner } from '@/lib/access'
import { clubCount, listClubs, listServers, pickServer } from '@/lib/clubs'
import { listProjects } from '@/lib/projects'
import { projectHealth } from '@/lib/projectCanvas'
import { toNode } from '@/lib/projectNodes'
import { getSettings } from '@/lib/settings'
import { ProjectMiniMap } from '@/components/ProjectMiniMap'
import { projectCosts } from '@/plugins/server'
import { ActionForm } from '@/components/ActionForm'
import { Icon } from '@/components/Icon'
import { ActionButton, Popup, Toolbar } from '@/components/Popup'
import { connectServicesAction, createProjectAction } from './actions'

export const metadata = { title: 'Projects' }
export const dynamic = 'force-dynamic'


export default async function ProjectsPage({ searchParams }: { searchParams: Promise<{ q?: string; show?: string }> }) {
  const admin = await requireAdmin()
  const { q: rawQ = '', show = '' } = await searchParams
  const q = rawQ.trim().slice(0, 80)
  const owner = isOwner(admin)
  const clubs = listClubs()
  const servers = listServers()
  const serverName = new Map(servers.map((s) => [s.id, s.name]))
  const projects = listProjects()
    .map((p) => ({ ...p, services: clubs.filter((c) => c.projectId === p.id) }))
    .filter((p) => canSeeProject(admin, p.id, p.services.map((c) => c.id)))
  const costs = owner ? projectCosts() : new Map<number, string>()
  const baseDomain = getSettings().baseDomain
  const rows = projects.map((p) => {
    const shown = p.services.filter((c) => canSeeSite(admin, c.id) || canBuildInProject(admin, p.id))
    const ids = new Set(shown.map((c) => c.id))
    const nodes = shown.map((c) => toNode(c, baseDomain, p.services, ids, false))
    const health = projectHealth(nodes.map((n) => n.tone))
    return { p, shown, nodes, health, attention: health.tone === 'bad' || health.tone === 'warn' || shown.some((c) => c.pgReadOnly || c.pgAlertLevel > 0) }
  })
  const needle = q.toLowerCase()
  const listed = rows
    .filter((r) => show !== 'attention' || r.attention)
    .filter((r) => !needle || [r.p.displayName, r.p.name, r.p.description, ...r.shown.flatMap((c) => [c.name, c.displayName])].some((t) => t.toLowerCase().includes(needle)))
  const unsynced = owner ? clubs.filter((c) => c.projectSynced === 2).length : 0

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Projects</h1>
          <p className="muted">A project groups the services that work together on one server: apps from GitHub or Docker images, PostgreSQL databases and services from plugins. Each project has its own private network, so its services reach each other by name and nothing in another project can reach them.</p>
        </div>
        {owner && <Toolbar>
          {unsynced > 0 && <ActionButton action={connectServicesAction} label="Connect services" icon="link" busy="Queuing…" />}
          <Popup label="New project" title="New project" icon="plus" primary>
            <ActionForm action={createProjectAction} submit="Create project" busy="Creating…">
              <div className="field"><label htmlFor="displayName">Name</label><input id="displayName" name="displayName" type="text" required maxLength={80} placeholder="Riverside shop" /></div>
              <div className="field"><label htmlFor="name">Short name</label><input id="name" name="name" type="text" maxLength={28} pattern="[a-z][a-z0-9\-]{1,27}" placeholder="riverside-shop" autoCapitalize="none" spellCheck={false} />
                <div className="help">Lowercase letters, digits and hyphens; made from the name when left empty. It names the project&apos;s network on the server and can&apos;t be changed.</div></div>
              <div className="field"><label htmlFor="serverId">Server</label>
                <select id="serverId" name="serverId" required defaultValue={(pickServer() ?? pickServer({ forApps: true }) ?? servers.find((s) => s.accepts_new))?.id ?? ''}>
                  {servers.map((s) => <option key={s.id} value={s.id}>{s.name} · {clubCount(s.id)} of {s.max_clubs} places{s.purpose === 'apps' ? ' · apps only' : ''}{s.accepts_new ? '' : ' (closed to new sites)'}</option>)}
                </select>
                <div className="help">Every service of a project runs on this server. The one with the most room is picked. {pickServer() ? 'Need more room?' : 'Every server is full:'} <Link href="/admin/servers">Create a server</Link> first, then come back.</div></div>
              <div className="field"><label htmlFor="description">What it is for (optional)</label><input id="description" name="description" type="text" maxLength={500} /></div>
            </ActionForm>
          </Popup>
        </Toolbar>}
      </div>

      {unsynced > 0 && (
        <div className="notice warn">
          {unsynced} service{unsynced === 1 ? ' is' : 's are'} not on {unsynced === 1 ? 'its' : 'their'} project network yet because the server&apos;s clubctl is older than projects. Run the &quot;Set up a VM&quot; workflow for that server again, then press Connect services.
        </div>
      )}

      {projects.length === 0 ? (
        <div className="card"><p className="muted" style={{ margin: 0 }}>{owner ? 'No projects yet. Every new site, app or database gets one, or make one with “New project”.' : 'No projects have been shared with you yet.'}</p></div>
      ) : (
        <>
          <form className="pl-tools" method="get">
            <input type="search" name="q" defaultValue={q} placeholder="Search projects and services" aria-label="Search projects and services" />
            {show === 'attention' && <input type="hidden" name="show" value="attention" />}
            <div className="tabs-row" style={{ margin: 0 }}>
              <Link href={q ? `?q=${encodeURIComponent(q)}` : '?'} className={show === 'attention' ? '' : 'on'}>All {rows.length}</Link>
              <Link href={`?show=attention${q ? `&q=${encodeURIComponent(q)}` : ''}`} className={show === 'attention' ? 'on' : ''}>Needs attention {rows.filter((r) => r.attention).length}</Link>
            </div>
          </form>
          {listed.length === 0 ? <div className="card"><p className="muted" style={{ margin: 0 }}>{show === 'attention' ? 'Nothing needs attention.' : 'No project matches that search.'}</p></div> : (
            <div className="pl-grid">
              {listed.map(({ p, nodes, health }) => (
                <Link key={p.id} href={`/admin/projects/${p.id}`} className="pl-tile">
                  <ProjectMiniMap nodes={nodes} />
                  <span className="pl-tile-body">
                    <span className="pl-tile-row"><strong>{p.displayName}</strong>{owner && costs.has(p.id) && <span className="muted small" title="Estimate a month, from what the servers cost">{costs.get(p.id)}/mo</span>}</span>
                    <span className="pl-tile-row">
                      <span className="muted small">{nodes.length} service{nodes.length === 1 ? '' : 's'} · {serverName.get(p.serverId) ?? 'server gone'}</span>
                      {nodes.length > 0 && <span className={`pc-status ${health.tone}`}><i />{health.label}</span>}
                    </span>
                    {p.description && <span className="muted small pl-desc">{p.description}</span>}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </>
      )}
    </>
  )
}
