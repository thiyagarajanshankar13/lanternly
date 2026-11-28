import { requireOwner, requireProject } from '@/lib/guards'
import { requireAdmin } from '@/lib/auth'
import { canBuildInProject, isOwner } from '@/lib/access'
import { listProjects } from '@/lib/projects'
import { linkableIn } from '@/lib/services'
import { ProjectChoice } from '@/components/ProjectChoice'
import Link from 'next/link'
import { clubCount, listServers } from '@/lib/clubs'
import { getSettings } from '@/lib/settings'
import { ActionForm } from '@/components/ActionForm'
import { RepoBranchPicker } from '@/components/RepoBranchPicker'
import { github, githubConfigured, type Repo } from '@/lib/apps/github'
import { createAppAction } from '../actions'

export const metadata = { title: 'New app' }
export const dynamic = 'force-dynamic'

export default async function NewAppPage({ searchParams }: { searchParams: Promise<{ project?: string }> }) {
  // Owners, or operators adding an app to a project they run.
  const asked = Number((await searchParams).project) || 0
  if (asked) await requireProject(asked, 'build'); else await requireOwner()
  const admin = await requireAdmin()
  const owner = isOwner(admin)
  const settings = getSettings()
  const servers = listServers()
  const serverName = new Map(servers.map((s) => [s.id, s.name]))
  const projects = listProjects().filter((p) => canBuildInProject(admin, p.id)).map((p) => ({
    id: p.id, displayName: p.displayName, server: serverName.get(p.serverId) ?? '',
    databases: linkableIn(p.id).map((d) => ({ id: d.id, name: d.name, displayName: d.displayName, kind: d.kind, buckets: d.s3Buckets.map((b) => b.name) })),
  }))
  const ready = githubConfigured()
  let repos: Repo[] = []
  let repoError = ''
  if (ready) {
    try { repos = await github().listRepos() } catch (err) { repoError = (err as Error).message }
  }
  return (
    <>
      <div className="page-head">
        <div>
          <p className="small" style={{ marginBottom: 4 }}>{asked ? <Link href={`/admin/projects/${asked}`}>← Project</Link> : <Link href="/admin/services">← Sites</Link>}</p>
          <h1>New app</h1>
          <p className="muted">Runs an app from a GitHub repo and branch: it is built on GitHub from the repo&apos;s Dockerfile, started on a sites server and given HTTPS. The first build usually takes one to three minutes. To run a ready-made image from Docker Hub instead, use <Link href={asked ? `/admin/apps/image?project=${asked}` : '/admin/apps/image'}>New service from an image</Link>.</p>
        </div>
      </div>
      {!ready && (
        <div className="notice warn">GitHub isn&apos;t set up yet. <Link href="/admin/settings">Add the GitHub App in Settings</Link> first.</div>
      )}
      <ActionForm action={createAppAction} submit="Create app" busy="Starting the build…">
        <div className="card">
          <h2>The app</h2>
          <div className="grid cols-2">
            <div className="field">
              <label htmlFor="displayName">Name</label>
              <input id="displayName" name="displayName" type="text" required maxLength={80} placeholder="Shop website" />
            </div>
            <div className="field">
              <label htmlFor="name">Web address</label>
              <div className="input-row">
                <input id="name" name="name" type="text" required pattern="[a-z][a-z0-9\-]{1,30}" maxLength={31} placeholder="my-app" autoCapitalize="none" spellCheck={false} />
                <span className="suffix">.{settings.baseDomain}</span>
              </div>
              <div className="help">Lowercase letters, digits and hyphens. A custom domain can be added once it is running.</div>
            </div>
          </div>
          <RepoBranchPicker repos={repos.map((r) => ({ fullName: r.fullName, defaultBranch: r.defaultBranch }))} error={repoError} />
          <label className="small" style={{ fontWeight: 400 }}><input type="checkbox" name="appAutoDeploy" defaultChecked /> Deploy every push to this branch by itself</label>
        </div>

        <div className="card">
          <h2>Project, databases and storage</h2>
          <ProjectChoice projects={projects} initial={asked || undefined} fixed={!!asked} allowNew={owner} />
        </div>

        <div className="card">
          <h2>How it runs</h2>
          <p className="muted">The repo needs a Dockerfile. The app must listen on the port below (it is also given as <code>PORT</code>) and answer the health page with a normal (not an error) page once it is ready.</p>
          <div className="grid cols-2">
            <div className="field"><label htmlFor="appPort">Port</label><input id="appPort" name="appPort" type="number" min={1} max={65535} defaultValue={3000} required /></div>
            <div className="field"><label htmlFor="appHealthPath">Health page</label><input id="appHealthPath" name="appHealthPath" type="text" defaultValue="/" placeholder="/health" spellCheck={false} /><div className="help">Checked before each new version takes over, and by Monitoring.</div></div>
          </div>
          <div className="field"><label htmlFor="appPredeploy">Pre-deploy command (optional)</label><input id="appPredeploy" name="appPredeploy" type="text" maxLength={500} spellCheck={false} placeholder="npm run migrate" />
            <div className="help">Runs once in each new version, with its settings and database variables, before it takes over. Use it for database migrations. If it fails, the version already running stays.</div></div>
        </div>

        <div className="card">
          <h2>Settings</h2>
          <div className="field">
            <label htmlFor="extraEnv">Settings</label>
            <textarea id="extraEnv" name="extraEnv" placeholder={'SITE_NAME=My shop\nMAIL_TO=beta@example.com\nSMTP_HOST=smtp.example.com'} spellCheck={false} />
            <div className="help">One KEY=value per line, given to the app as environment variables. Shown again on the app&apos;s page. A value can use a database of the project, like <span className="mono">{'REPORTS_URL=${{shop-db.DATABASE_URL}}'}</span>.</div>
          </div>
          <div className="field">
            <label htmlFor="secretEnv">Secret settings</label>
            <textarea id="secretEnv" name="secretEnv" placeholder={'SMTP_PASS=…'} spellCheck={false} autoComplete="off" />
            <div className="help">Passwords and keys, one KEY=value per line. Stored encrypted and never shown again (only their names).</div>
          </div>
        </div>

        <div className="card">
          <details>
            <summary>{asked ? 'Dockerfile and memory' : 'Dockerfile, memory and server'}</summary>
            <div className="grid cols-2" style={{ marginTop: 14 }}>
              <div className="field"><label htmlFor="appDockerfile">Dockerfile</label><input id="appDockerfile" name="appDockerfile" type="text" defaultValue="Dockerfile" spellCheck={false} /><div className="help">Its path in the repo. The build runs from the repo&apos;s top folder.</div></div>
              <div className="field"><label htmlFor="memoryMb">Memory limit (MB)</label><input id="memoryMb" name="memoryMb" type="number" min={64} max={4000} defaultValue={settings.appDefaultMemoryMb} /></div>
              {!asked && owner && <div className="field"><label htmlFor="serverId">Server</label>
                <select id="serverId" name="serverId" defaultValue="">
                  <option value="">Pick the one with most room</option>
                  {servers.map((s) => <option key={s.id} value={s.id}>{s.name} ({clubCount(s.id)} of {s.max_clubs})</option>)}
                </select><div className="help">Only for a new project: an existing project&apos;s apps run on its server.</div></div>}
              <div className="field"><label htmlFor="notes">Notes (only shown here)</label><input id="notes" name="notes" type="text" maxLength={300} /></div>
            </div>
          </details>
        </div>
      </ActionForm>
    </>
  )
}
