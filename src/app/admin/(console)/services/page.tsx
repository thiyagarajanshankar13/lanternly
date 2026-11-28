import Link from 'next/link'
import { imageDisplay } from '@/lib/apps/imageRef'
import { clubCount, listClubs, listServers } from '@/lib/clubs'
import { clubDomains } from '@/lib/clubEnv'
import { getSettings } from '@/lib/settings'
import { LiveServer } from '@/components/LiveServer'
import { ClubBadge, fmtTime } from '@/components/ui'
import { Icon } from '@/components/Icon'
import { Toolbar } from '@/components/Popup'
import { shaOfImage } from '@/lib/apps/config'
import { listProjects } from '@/lib/projects'
import { requireAdmin } from '@/lib/auth'
import { isOwner, visibleTo } from '@/lib/access'
import { PLUGINS, enabledPlugins, hiddenByPlugin, servicesLabel } from '@/plugins'
import { serviceKindParts, sitesPageParts } from '@/plugins/parts'

export function generateMetadata() {
  return { title: servicesLabel() }
}

export default async function ClubsPage() {
  const admin = await requireAdmin()
  const owner = isOwner(admin)
  const plugins = enabledPlugins()
  // A plugin's services are only listed while it is on (they keep running either way).
  const clubs = visibleTo(admin, listClubs(), (c) => c.id).filter((c) => !hiddenByPlugin(c, plugins))
  // Servers, releases and roll-outs are for owners; everyone else just sees their sites.
  const servers = owner ? listServers() : []
  const settings = getSettings()
  const places = servers.reduce((n, s) => n + s.max_clubs, 0)
  const projectName = new Map(listProjects().map((p) => [p.id, p.displayName]))
  const parts = owner ? sitesPageParts() : []
  // "Sites" while a plugin with sites is on, else "services".
  const label = servicesLabel(plugins)
  const one = label === 'Sites' ? 'site' : 'service'
  const intro = PLUGINS.find((p) => plugins.has(p.id) && p.servicesIntro)?.servicesIntro

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{servicesLabel(plugins)}</h1>
          <p className="muted">{intro ?? 'Each service is an app built from a GitHub repo, a Docker image or a PostgreSQL database.'} {label} are grouped into <Link href="/admin/projects">projects</Link>.</p>
        </div>
        {owner && <Toolbar>
          {parts.map((p, i) => p.Toolbar ? <p.Toolbar key={i} clubs={clubs} /> : null)}
          <Link className="btn" href="/admin/apps/new"><Icon name="rocket" size={16} /><span className="tb-label">New app</span></Link>
          {parts.map((p, i) => p.ToolbarEnd ? <p.ToolbarEnd key={i} clubs={clubs} /> : null)}
        </Toolbar>}
      </div>

      {owner && servers.length === 0 && (
        <div className="notice warn">No server yet. <Link href="/admin/servers">Add a server</Link> before creating a {one}.</div>
      )}
      {parts.map((p, i) => p.Notices ? <p.Notices key={i} clubs={clubs} /> : null)}

      <div className="grid cols-3" style={{ marginBottom: 16 }}>
        <div className="card" style={{ marginBottom: 0 }}><div className="stat">{clubs.length}</div><div className="stat-label">{owner ? `${one}s of ${places} places` : `${one}${clubs.length === 1 ? '' : 's'} you can see`}</div></div>
        <div className="card" style={{ marginBottom: 0 }}><div className="stat">{clubs.filter((c) => c.status === 'running').length}</div><div className="stat-label">running</div></div>
        <div className="card" style={{ marginBottom: 0 }}><div className="stat">{clubs.filter((c) => c.status === 'paused').length}</div><div className="stat-label">paused</div></div>
      </div>

      {servers.map((s) => (
        <div className="card" key={s.id}>
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
            <h2 style={{ margin: 0 }}>{s.name}</h2>
            <span className="muted small">{clubCount(s.id)} of {s.max_clubs} places used{s.accepts_new ? '' : ' · closed to new sites'}</span>
          </div>
          <LiveServer serverId={s.id} />
        </div>
      ))}

      <div className="card">
        {clubs.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>{owner ? `No ${one}s yet. Create the first one with “New ${parts.some((p) => p.ToolbarEnd) ? one : 'app'}”.` : `No ${one}s have been shared with you yet. Ask an owner to add some under People.`}</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>{label === 'Sites' ? 'Site' : 'Service'}</th><th>Project</th><th>Address</th><th>Status</th><th>Add-ons</th><th>Version</th><th>Created</th></tr></thead>
              <tbody>
                {clubs.map((c) => {
                  const main = clubDomains(c, settings.baseDomain)[0]
                  const kind = serviceKindParts(c.kind)
                  return (
                    <tr key={c.id}>
                      <td><Link href={`/admin/clubs/${c.id}`}><strong>{c.displayName}</strong></Link><div className="muted small">{c.name}</div></td>
                      <td>{c.projectId ? <Link href={`/admin/projects/${c.projectId}`}>{projectName.get(c.projectId) ?? '–'}</Link> : <span className="muted">–</span>}</td>
                      <td>{c.kind === 'postgres' ? <span className="mono muted small">{c.name}:5432 (inside its project)</span> : !main ? <span className="mono muted small">{c.name}:{c.kind === 'minio' ? 9000 : c.appPort} (inside its project)</span> : <a href={`https://${main}`} target="_blank" rel="noreferrer">{main}</a>}</td>
                      <td><ClubBadge status={c.status} /></td>
                      <td>{c.kind === 'app' ? <span className="badge">{c.appImageRef ? 'Image' : 'App'}</span> : c.kind === 'postgres' ? <span className="badge info">PostgreSQL</span> : c.kind === 'minio' ? <span className="badge info">S3 storage</span> : kind?.Addons ? <kind.Addons club={c} /> : <span className="muted">–</span>}</td>
                      <td title={c.kind === 'app' ? (c.appImageRef ? c.image : `${c.appRepo} @ ${c.appBranch}`) : c.image}>
                        {c.kind === 'app' && c.appImageRef ? <span className="mono">{imageDisplay(c.appImageRef)}</span> : c.kind === 'app' ? <><span className="mono">{shaOfImage(c.image).slice(0, 7) || '–'}</span> <span className="muted small">{c.appBranch}</span></> : c.kind === 'postgres' ? <span className="mono">{c.image}</span> : c.kind === 'minio' ? <span className="muted small">{c.s3Buckets.map((b) => b.name).join(', ')}</span> : kind?.Version ? <kind.Version club={c} owner={owner} /> : <span className="mono">{c.image}</span>}
                        {c.testSite && <span className="badge info" style={{ marginLeft: 6 }}>test site</span>}
                        {c.pinned && <span className="badge" style={{ marginLeft: 6 }}>pinned</span>}
                      </td>
                      <td className="muted">{fmtTime(c.createdAt)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

    </>
  )
}
