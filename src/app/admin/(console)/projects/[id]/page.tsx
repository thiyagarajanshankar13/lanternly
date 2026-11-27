import Link from 'next/link'
import { canBuildInProject, canOperateSite, canSeeSite, isOwner, roleLabel } from '@/lib/access'
import { listAdmins } from '@/lib/auth'
import { getServer } from '@/lib/clubs'
import { clubDomains } from '@/lib/clubEnv'
import { requireProject } from '@/lib/guards'
import { PG_DEFAULT_VERSION, PG_MEMORY_MAX, PG_MEMORY_MIN, PG_VERSIONS, S3_MEMORY_MAX, S3_MEMORY_MIN, pgVersionOf } from '@/lib/projects'
import { kindLabel, appsUsing, servicesOf } from '@/lib/services'
import { imageDisplay } from '@/lib/apps/imageRef'
import { PG_DEFAULT_MEMORY_MB, PG_DEFAULT_QUOTA_MB } from '@/lib/postgres/service'
import { S3_DEFAULT_MEMORY_MB, S3_DEFAULT_QUOTA_MB } from '@/lib/storage/service'
import { projectCosts } from '@/plugins/server'
import { getSettings } from '@/lib/settings'
import { ActionForm } from '@/components/ActionForm'
import { Icon } from '@/components/Icon'
import { MoreMenu, Popup, Toolbar } from '@/components/Popup'
import { NewServicePicker } from '@/components/NewServicePicker'
import { fmtTime } from '@/components/ui'
import { ProjectCanvas } from '@/components/ProjectCanvas'
import { projectHealth, type CanvasNode } from '@/lib/projectCanvas'
import { toNode } from '@/lib/projectNodes'
import { hiddenByPlugin, newServiceLinks } from '@/plugins'
import { createDatabaseAction, createStorageAction, deleteProjectAction, updateProjectAction } from '../actions'

export const metadata = { title: 'Project' }
export const dynamic = 'force-dynamic'

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { admin, project } = await requireProject(Number((await params).id), 'view')
  const owner = isOwner(admin)
  const build = canBuildInProject(admin, project.id)
  const settings = getSettings()
  const server = getServer(project.serverId)
  const all = servicesOf(project.id)
  const services = all.filter((c) => (canSeeSite(admin, c.id) || build) && !hiddenByPlugin(c))
  const databases = all.filter((c) => c.kind === 'postgres')
  // Suggested name for a new database: <project>-db, then -db-2, -db-3… if taken.
  const taken = new Set(all.map((c) => c.name))
  const dbBase = `${project.name.slice(0, 27)}-db`
  let dbName = dbBase
  for (let n = 2; taken.has(dbName) && n < 100; n++) dbName = `${dbBase}-${n}`
  const storages = all.filter((c) => c.kind === 'minio')
  const s3Base = `${project.name.slice(0, 24)}-files`
  let s3Name = s3Base
  for (let n = 2; taken.has(s3Name) && n < 100; n++) s3Name = `${s3Base}-${n}`
  const cost = owner ? projectCosts().get(project.id) : undefined
  const shownIds = new Set(services.map((c) => c.id))
  const nodes: CanvasNode[] = services.map((c) => toNode(c, settings.baseDomain, all, shownIds, canOperateSite(admin, c.id)))
  const health = projectHealth(nodes.map((n) => n.tone))
  const people = owner ? listAdmins().filter((a) => a.role !== 'owner' && !a.suspended && (a.allSites || (a.projectIds ?? []).includes(project.id) || all.some((c) => a.siteIds.includes(c.id)))) : []

  return (
    <>
      <div className="page-head">
        <div>
          <p className="small" style={{ marginBottom: 4 }}><Link href="/admin/projects">← Projects</Link></p>
          <h1><Icon name="project" size={22} /> {project.displayName}</h1>
          {project.description && <p className="muted">{project.description}</p>}
        </div>
        <Toolbar>
          {build && (
            <Popup label="New service" title="Add a service" icon="plus" primary panel subtitle={`What do you want to add to ${project.displayName}? It runs on this project's server and joins its private network.`}>
              <NewServicePicker
                pluginChoices={owner ? newServiceLinks().map((n) => ({ href: `${n.href}?project=${project.id}`, icon: n.icon, title: n.title, text: n.text, from: `${n.plugin.name} plugin` })) : []}
                githubHref={`/admin/apps/new?project=${project.id}`}
                imageHref={`/admin/apps/image?project=${project.id}`}
                databases={databases.map((d) => d.name)}
                storages={storages.map((d) => d.name)}
                storageForm={
                  <ActionForm action={createStorageAction} submit="Add storage" busy="Creating…">
                    <input type="hidden" name="projectId" value={project.id} />
                    <div className="grid cols-2">
                      <div className="field"><label htmlFor="s3-name">Name</label><input id="s3-name" name="name" type="text" required pattern="[a-z][a-z0-9\-]{1,30}" maxLength={31} defaultValue={s3Name} autoCapitalize="none" spellCheck={false} />
                        <div className="help">Apps reach it at <span className="mono">http://name:9000</span>.</div></div>
                      <div className="field"><label htmlFor="s3-bucket">First bucket</label><input id="s3-bucket" name="bucket" type="text" required pattern="[a-z0-9][a-z0-9\-]{1,61}[a-z0-9]" maxLength={63} defaultValue="files" autoCapitalize="none" spellCheck={false} />
                        <div className="help">Add more on its page later.</div></div>
                    </div>
                    <fieldset className="field" style={{ border: 0, padding: 0, margin: '0 0 14px' }}>
                      <legend style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>Web address</legend>
                      <label className="module" style={{ marginBottom: 6 }}><input type="radio" name="web" value="off" defaultChecked /><span><strong>Only inside this project</strong><span className="muted small">Apps upload and serve files themselves.</span></span></label>
                      <label className="module"><input type="radio" name="web" value="on" /><span><strong>Also on the web, at <span className="mono">{s3Name}.{settings.baseDomain || 'your domain'}</span></strong><span className="muted small">For download links browsers open directly (signed links, or a bucket anyone can read).</span></span></label>
                    </fieldset>
                    <label className="small" style={{ fontWeight: 400, marginBottom: 14 }}><input type="checkbox" name="publicBucket" /> Anyone with a link can read files in the first bucket (for public images)</label>
                    <details className="svc-size">
                      <summary><span>Size and limits</span><span className="muted small">{S3_DEFAULT_MEMORY_MB} MB memory · {(S3_DEFAULT_QUOTA_MB / 1024).toLocaleString('en')} GB quota</span></summary>
                      <div className="grid cols-2">
                        <div className="field"><label htmlFor="s3-memory">Memory (MB)</label><input id="s3-memory" name="memoryMb" type="number" min={S3_MEMORY_MIN} max={S3_MEMORY_MAX} defaultValue={S3_DEFAULT_MEMORY_MB} /></div>
                        <div className="field"><label htmlFor="s3-quota">Quota (GB)</label><input id="s3-quota" name="quotaGb" type="number" min={1} max={1950} step={1} defaultValue={S3_DEFAULT_QUOTA_MB / 1024} />
                          <div className="help">Emails at 80% and 100%. It never stops apps saving files; the server&apos;s disk is the real limit.</div></div>
                      </div>
                    </details>
                    <p className="help">To use it in an app, tick it under Databases and storage in the app&apos;s settings.</p>
                  </ActionForm>
                }>
                <ActionForm action={createDatabaseAction} submit="Create database" busy="Creating…">
                  <input type="hidden" name="projectId" value={project.id} />
                  <div className="grid cols-2">
                    <div className="field"><label htmlFor="db-name">Name</label><input id="db-name" name="name" type="text" required pattern="[a-z][a-z0-9\-]{1,30}" maxLength={31} defaultValue={dbName} autoCapitalize="none" spellCheck={false} />
                      <div className="help">Apps reach it at <span className="mono">name:5432</span>. Lowercase letters, digits and hyphens.</div></div>
                    <div className="field"><label htmlFor="db-version">Version</label>
                      <select id="db-version" name="version" defaultValue={PG_DEFAULT_VERSION}>{PG_VERSIONS.map((v) => <option key={v} value={v}>PostgreSQL {v}</option>)}</select></div>
                  </div>
                  <details className="svc-size">
                    <summary><span>Size and limits</span><span className="muted small">{PG_DEFAULT_MEMORY_MB} MB memory · {(PG_DEFAULT_QUOTA_MB / 1024).toLocaleString('en')} GB disk quota</span></summary>
                    <div className="grid cols-2">
                      <div className="field"><label htmlFor="db-memory">Memory (MB)</label><input id="db-memory" name="memoryMb" type="number" min={PG_MEMORY_MIN} max={PG_MEMORY_MAX} defaultValue={PG_DEFAULT_MEMORY_MB} /></div>
                      <div className="field"><label htmlFor="db-quota">Disk quota (GB)</label><input id="db-quota" name="quotaGb" type="number" min={0.25} max={195} step={0.25} defaultValue={PG_DEFAULT_QUOTA_MB / 1024} />
                        <div className="help">Emails at 80%. At 100% it only reads until the quota is raised or data deleted.</div></div>
                    </div>
                  </details>
                  <p className="help">Only services in this project can reach it. To use it in an app, tick it under Databases in the app&apos;s settings.</p>
                </ActionForm>
              </NewServicePicker>
            </Popup>
          )}
          {owner && (
            <MoreMenu>
              <Popup menu label="Edit project" title="Edit project" icon="edit">
                <ActionForm action={updateProjectAction} submit="Save" busy="Saving…">
                  <input type="hidden" name="id" value={project.id} />
                  <div className="field"><label htmlFor="p-name">Name</label><input id="p-name" name="displayName" type="text" required maxLength={80} defaultValue={project.displayName} /></div>
                  <div className="field"><label htmlFor="p-desc">What it is for</label><input id="p-desc" name="description" type="text" maxLength={500} defaultValue={project.description} /></div>
                  <p className="help">The short name <span className="mono">{project.name}</span> names its network on the server, so it stays.</p>
                </ActionForm>
              </Popup>
              <hr />
              <Popup menu danger label="Remove project…" title="Remove this project" icon="trash">
                {all.length ? (
                  <p className="muted">Remove or move its {all.length} service{all.length === 1 ? '' : 's'} first (each service&apos;s page has Move to project and Remove).</p>
                ) : (
                  <ActionForm action={deleteProjectAction} submit="Remove project" busy="Removing…" danger>
                    <input type="hidden" name="id" value={project.id} />
                    <div className="field"><label htmlFor="p-confirm">Type <span className="mono">{project.name}</span> to confirm</label><input id="p-confirm" name="confirm" type="text" autoComplete="off" style={{ maxWidth: 260 }} /></div>
                  </ActionForm>
                )}
              </Popup>
            </MoreMenu>
          )}
        </Toolbar>
      </div>

      <div className="pc-summary">
        <span className={`pc-status ${health.tone}`}><i />{health.label}</span>
        <span><b>{all.length}</b> service{all.length === 1 ? '' : 's'}</span>
        <span>Server <b>{server?.name ?? 'gone'}</b></span>
        <span>Network <span className="mono">proj-{project.name}</span></span>
        {cost ? <span title="Estimate a month, from what the servers cost"><b>{cost}</b>/mo estimate</span> : <span><b>{all.reduce((n, c) => n + c.memoryMb, 0).toLocaleString('en')} MB</b> memory</span>}
      </div>

      {services.length === 0 ? (
        <div className="card"><p className="muted" style={{ margin: 0 }}>No services yet.{build ? ' Add one with “New service”.' : ''}</p></div>
      ) : (
        <ProjectCanvas nodes={nodes} />
      )}

      {databases.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <h2>Using the databases in an app</h2>
          <p className="muted small" style={{ marginTop: 0 }}>In an app&apos;s settings, tick a database under <strong>Databases</strong> to get <span className="mono">DATABASE_URL</span>, <span className="mono">PGHOST</span>, <span className="mono">PGPORT</span>, <span className="mono">PGUSER</span>, <span className="mono">PGPASSWORD</span> and <span className="mono">PGDATABASE</span> (with an optional prefix, such as <span className="mono">ANALYTICS_</span>, for a second one). Or refer to one value in any setting:</p>
          <pre className="mono small" style={{ margin: 0 }}>{databases.slice(0, 2).map((d) => `MY_DB_URL=\${{${d.name}.DATABASE_URL}}`).join('\n')}</pre>
          <p className="help">The password is filled in on the server, so it never shows in the settings.</p>
        </div>
      )}

      {storages.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <h2>Using the storage in an app</h2>
          <p className="muted small" style={{ marginTop: 0 }}>In an app&apos;s settings, tick a storage under <strong>Databases and storage</strong> and pick its bucket to get <span className="mono">S3_ENDPOINT</span>, <span className="mono">S3_BUCKET</span>, <span className="mono">S3_ACCESS_KEY_ID</span>, <span className="mono">S3_SECRET_ACCESS_KEY</span>, <span className="mono">S3_REGION</span>, <span className="mono">S3_PUBLIC_URL</span> and <span className="mono">S3_FORCE_PATH_STYLE</span>, plus the <span className="mono">AWS_*</span> names AWS SDKs read by themselves. Or refer to one value in any setting:</p>
          <pre className="mono small" style={{ margin: 0 }}>{storages.slice(0, 2).map((d) => `FILES_SECRET=\${{${d.name}.S3_SECRET_ACCESS_KEY}}`).join('\n')}</pre>
          <p className="help">The secret key is filled in on the server, so it never shows in the settings.</p>
        </div>
      )}

      {owner && (
        <div className="card">
          <h2>Who else can see it</h2>
          {people.length === 0 ? <p className="muted" style={{ margin: 0 }}>Only owners. Give someone the whole project, or some of its services, under <Link href="/admin/people">People</Link>.</p> : (
            <div className="table-wrap"><table>
              <thead><tr><th>Person</th><th>Role</th><th>Reaches</th></tr></thead>
              <tbody>{people.map((p) => (
                <tr key={p.id}>
                  <td>{p.name || p.email}<div className="muted small">{p.email}</div></td>
                  <td>{roleLabel(p.role)}</td>
                  <td className="small">{p.allSites ? 'Everything' : (p.projectIds ?? []).includes(project.id) ? `The whole project${p.role === 'operator' ? ', and can add services' : ''}` : all.filter((c) => p.siteIds.includes(c.id)).map((c) => c.displayName).join(', ')}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </div>
      )}

      <p className="muted small">Created {fmtTime(project.createdAt)}{project.createdBy ? ` by ${project.createdBy}` : ''}.</p>
    </>
  )
}
