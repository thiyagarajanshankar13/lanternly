import Link from 'next/link'
import { requireOwner, requireProject } from '@/lib/guards'
import { requireAdmin } from '@/lib/auth'
import { canBuildInProject, isOwner } from '@/lib/access'
import { listProjects } from '@/lib/projects'
import { databasesIn } from '@/lib/services'
import { clubCount, listServers } from '@/lib/clubs'
import { getSettings } from '@/lib/settings'
import { ActionForm } from '@/components/ActionForm'
import { ProjectChoice } from '@/components/ProjectChoice'
import { createImageAppAction } from '../actions'

export const metadata = { title: 'New service from an image' }
export const dynamic = 'force-dynamic'

export default async function NewImageAppPage({ searchParams }: { searchParams: Promise<{ project?: string }> }) {
  // Owners, or operators adding a service to a project they run.
  const asked = Number((await searchParams).project) || 0
  if (asked) await requireProject(asked, 'build'); else await requireOwner()
  const admin = await requireAdmin()
  const owner = isOwner(admin)
  const settings = getSettings()
  const servers = listServers()
  const serverName = new Map(servers.map((s) => [s.id, s.name]))
  const projects = listProjects().filter((p) => canBuildInProject(admin, p.id)).map((p) => ({
    id: p.id, displayName: p.displayName, server: serverName.get(p.serverId) ?? '',
    databases: databasesIn(p.id).map((d) => ({ id: d.id, name: d.name, displayName: d.displayName })),
  }))
  return (
    <>
      <div className="page-head">
        <div>
          <p className="small" style={{ marginBottom: 4 }}>{asked ? <Link href={`/admin/projects/${asked}`}>← Project</Link> : <Link href="/admin/projects">← Projects</Link>}</p>
          <h1>New service from an image</h1>
          <p className="muted">Runs a ready-made Docker image, from Docker Hub or another registry, on the project&apos;s server. Nothing is built: the image is pulled and started, usually in under a minute.</p>
        </div>
      </div>
      <ActionForm action={createImageAppAction} submit="Create service" busy="Pulling…">
        <div className="card">
          <h2>The image</h2>
          <div className="field">
            <label htmlFor="imageRef">Image</label>
            <input id="imageRef" name="imageRef" type="text" required maxLength={500} placeholder="nginx:1.27  or  https://hub.docker.com/_/nginx" autoCapitalize="none" spellCheck={false} className="mono" />
            <div className="help">A name like <span className="mono">nginx:1.27</span>, <span className="mono">owner/name:tag</span> or <span className="mono">ghcr.io/owner/name:tag</span>, or the image&apos;s hub.docker.com link. Pick a version tag rather than <span className="mono">latest</span>, so every restart runs the same thing.</div>
          </div>
          <div className="grid cols-2">
            <div className="field">
              <label htmlFor="displayName">Display name</label>
              <input id="displayName" name="displayName" type="text" required maxLength={80} placeholder="Shop cache" />
            </div>
            <div className="field">
              <label htmlFor="name">Name</label>
              <div className="input-row">
                <input id="name" name="name" type="text" required pattern="[a-z][a-z0-9\-]{1,30}" maxLength={31} placeholder="shop-cache" autoCapitalize="none" spellCheck={false} />
                <span className="suffix">.{settings.baseDomain}</span>
              </div>
              <div className="help">Other services in the project reach it by this name. Lowercase letters, digits and hyphens.</div>
            </div>
          </div>
          <details>
            <summary>Private image</summary>
            <p className="muted small" style={{ marginTop: 10 }}>For an image only your account can pull. On Docker Hub, make an access token with read-only access (Account settings → Personal access tokens); don&apos;t use your password. The token is stored encrypted and only used for each pull; the server keeps no sign-in.</p>
            <div className="grid cols-2">
              <div className="field"><label htmlFor="registryUser">User name</label><input id="registryUser" name="registryUser" type="text" autoComplete="off" spellCheck={false} /></div>
              <div className="field"><label htmlFor="registryToken">Access token</label><input id="registryToken" name="registryToken" type="password" autoComplete="new-password" /></div>
            </div>
          </details>
        </div>

        <div className="card">
          <h2>Project and databases</h2>
          <ProjectChoice projects={projects} initial={asked || undefined} fixed={!!asked} allowNew={owner} noNewDb />
        </div>

        <div className="card">
          <h2>How it runs</h2>
          <label className="small" style={{ fontWeight: 400, marginBottom: 12 }}><input type="checkbox" name="appPublic" defaultChecked /> Give it a web address with HTTPS (turn off for things only the project uses, like a cache or a worker)</label>
          <div className="grid cols-2">
            <div className="field"><label htmlFor="appPort">Port</label><input id="appPort" name="appPort" type="number" min={1} max={65535} defaultValue={80} required /><div className="help">The port the image listens on (its Docker Hub page usually says, for example 80 for nginx, 6379 for Redis). Also given as <code>PORT</code>.</div></div>
            <div className="field"><label htmlFor="appHealthPath">Health page (optional)</label><input id="appHealthPath" name="appHealthPath" type="text" placeholder="/health" spellCheck={false} /><div className="help">A page that answers once it is ready. Leave empty when it has no web pages: then running is enough.</div></div>
          </div>
          <div className="field"><label htmlFor="appPredeploy">Pre-deploy command (optional)</label><input id="appPredeploy" name="appPredeploy" type="text" maxLength={500} spellCheck={false} placeholder="./migrate.sh" />
            <div className="help">Runs once in each new version, with its settings and database variables, before it takes over. If it fails, the version already running stays.</div></div>
        </div>

        <div className="card">
          <h2>Settings</h2>
          <div className="field">
            <label htmlFor="extraEnv">Settings</label>
            <textarea id="extraEnv" name="extraEnv" placeholder={'NGINX_HOST=example.com\nTZ=Australia/Melbourne'} spellCheck={false} />
            <div className="help">One KEY=value per line, given to the container as environment variables (the image&apos;s Docker Hub page lists the ones it reads). A value can use a database of the project, like <span className="mono">{'DB_URL=${{shop-db.DATABASE_URL}}'}</span>.</div>
          </div>
          <div className="field">
            <label htmlFor="secretEnv">Secret settings</label>
            <textarea id="secretEnv" name="secretEnv" placeholder={'API_KEY=…'} spellCheck={false} autoComplete="off" />
            <div className="help">Passwords and keys, one KEY=value per line. Stored encrypted and never shown again (only their names).</div>
          </div>
        </div>

        <div className="card">
          <details>
            <summary>{asked ? 'Memory' : 'Memory and server'}</summary>
            <div className="grid cols-2" style={{ marginTop: 14 }}>
              <div className="field"><label htmlFor="memoryMb">Memory limit (MB)</label><input id="memoryMb" name="memoryMb" type="number" min={64} max={4000} defaultValue={settings.appDefaultMemoryMb} /></div>
              {!asked && owner && <div className="field"><label htmlFor="serverId">Server</label>
                <select id="serverId" name="serverId" defaultValue="">
                  <option value="">Pick the one with most room</option>
                  {servers.map((s) => <option key={s.id} value={s.id}>{s.name} ({clubCount(s.id)} of {s.max_clubs})</option>)}
                </select><div className="help">Only for a new project: an existing project&apos;s services run on its server.</div></div>}
              <div className="field"><label htmlFor="notes">Notes (only shown here)</label><input id="notes" name="notes" type="text" maxLength={300} /></div>
            </div>
          </details>
        </div>
        <p className="help">It keeps no files of its own: anything it writes inside the container is lost when it restarts or updates, so keep data in a project database.</p>
      </ActionForm>
    </>
  )
}
