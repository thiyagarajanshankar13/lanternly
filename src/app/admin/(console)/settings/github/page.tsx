import Link from 'next/link'
import { requireOwner } from '@/lib/guards'
import { getSettings } from '@/lib/settings'
import { ActionForm } from '@/components/ActionForm'
import { CreateGithubApp } from '@/components/CreateGithubApp'
import { Popup, Toolbar } from '@/components/Popup'
import { github, githubConfigured } from '@/lib/apps/github'
import { BUILD_SECRET_ID, BUILD_SECRET_KEY, appInfo, installUrl, pendingApp } from '@/lib/apps/githubSetup'
import { isFakeEngine } from '@/lib/engine'
import { discardPendingGithubAppAction, saveBuildSecretsAction, testGithubAction } from '../../apps/actions'

export const metadata = { title: 'GitHub' }
export const dynamic = 'force-dynamic'

type Check = { ok: boolean | null; text: React.ReactNode; fix?: React.ReactNode }

/** Asks GitHub how the connection stands. Read-only (apart from remembering the App's name). */
async function checks(): Promise<{ list: Check[]; slug: string; name: string }> {
  const s = getSettings()
  const list: Check[] = []
  let slug = s.githubAppSlug, name = s.githubAppName
  let secretsWrite = false
  if (isFakeEngine()) {
    list.push({ ok: true, text: 'Practice mode: a simulated GitHub answers.' })
    return { list, slug, name }
  }
  try {
    const info = await appInfo()
    slug = info.slug; name = info.name
    secretsWrite = info.permissions.secrets === 'write'
    list.push({ ok: true, text: <>GitHub App <a href={info.htmlUrl} target="_blank" rel="noreferrer"><strong>{info.name}</strong></a>; its key works</> })
  } catch (err) {
    list.push({ ok: false, text: (err as Error).message })
    return { list, slug, name }
  }
  try {
    const repos = await github().listRepos()
    const build = s.githubBuildRepo.toLowerCase()
    list.push({ ok: repos.length > 0, text: <>Installed on <code>{s.githubOwner}</code>, sees {repos.length} repo{repos.length === 1 ? '' : 's'}</> })
    const hasBuild = repos.some((r) => r.fullName.toLowerCase() === build)
    list.push({
      ok: hasBuild, text: <>Builds run in <code>{s.githubBuildRepo}</code>{hasBuild ? ', and it can see that repo' : ', but it can\'t see that repo'}</>,
      fix: hasBuild ? undefined : slug ? <a className="btn" href={installUrl(slug)}>Add repos on GitHub</a> : undefined,
    })
  } catch (err) {
    list.push({ ok: false, text: (err as Error).message, fix: slug ? <a className="btn" href={installUrl(slug)}>Install on GitHub</a> : undefined })
    return { list, slug, name }
  }
  const saved = s.githubBuildSecretsFor === `${s.githubAppId} ${s.githubBuildRepo}`
  if (saved) list.push({ ok: true, text: <>Build secrets <code>{BUILD_SECRET_ID}</code> and <code>{BUILD_SECRET_KEY}</code> saved in that repo</> })
  else if (secretsWrite) list.push({ ok: false, text: <>The build secrets aren&apos;t saved in <code>{s.githubBuildRepo}</code> yet</>, fix: <ActionForm action={saveBuildSecretsAction} submit="Save build secrets" busy="Saving…">{null}</ActionForm> })
  else list.push({ ok: null, text: <>Build secrets <code>{BUILD_SECRET_ID}</code> and <code>{BUILD_SECRET_KEY}</code> are added by hand: this app may not change secrets (see the setup guide)</> })
  list.push(s.githubWebhookSecret ? { ok: true, text: 'Pushes deploy apps (webhook secret saved)' } : { ok: null, text: 'No webhook secret: apps only deploy when you press Deploy latest' })
  return { list, slug, name }
}

export default async function GithubPage({ searchParams }: { searchParams: Promise<{ done?: string; error?: string }> }) {
  await requireOwner()
  const q = await searchParams
  const s = getSettings()
  const pending = pendingApp()
  const connected = githubConfigured()
  const result = connected ? await checks() : null
  const allOk = !!result && result.list.every((c) => c.ok !== false)
  return (
    <>
      <div className="page-head">
        <div>
          <p className="small" style={{ marginBottom: 4 }}><Link href="/admin/settings">← Settings</Link></p>
          <h1>GitHub</h1>
          <p className="muted">The GitHub App the deployer uses to build and deploy apps from your repos.</p>
        </div>
        {connected && !isFakeEngine() && (
          <Toolbar>
            {result?.slug && <a className="btn" href={installUrl(result.slug)}>Add repos</a>}
            <Popup label="Replace with a new app" short="Replace" title="Replace the GitHub App" subtitle="Creates a new GitHub App and switches to it once it's installed." icon="rocket" panel>
              <CreateGithubApp owner={s.githubOwner} buildRepo={s.githubBuildRepo} label="Create a new GitHub app" replacing />
            </Popup>
          </Toolbar>
        )}
      </div>

      {q.error && <div className="notice bad" role="alert">{q.error}</div>}
      {q.done === 'switched' && <div className="notice ok" role="status">The new GitHub App is installed and in use.</div>}

      {pending && (
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2 style={{ margin: 0 }}>{pending.name} isn&apos;t installed yet</h2>
            <span className="badge warn">Waiting</span>
          </div>
          <p className="muted">It was created on GitHub. Install it on <code>{pending.owner}</code> and tick <code>{pending.buildRepo}</code> plus the repos you want to deploy.{connected ? ' Until then the deployer keeps using the app it has.' : ''}</p>
          <div className="row">
            <a className="btn primary" href={installUrl(pending.slug)}>Install on GitHub</a>
            <ActionForm action={discardPendingGithubAppAction} submit="Discard it" danger>{null}</ActionForm>
          </div>
        </div>
      )}

      {!connected && !pending && (
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2 style={{ margin: 0 }}>Connect GitHub</h2>
            <span className="badge warn">Not connected</span>
          </div>
          <p className="muted">The deployer creates its own GitHub App: you confirm it on GitHub, pick the repos, and come back here. No keys to copy.</p>
          <CreateGithubApp owner={s.githubOwner} buildRepo={s.githubBuildRepo} />
          <p className="small muted">Already have a GitHub App? Enter it by hand under <Link href="/admin/settings">Settings</Link> → GitHub apps.</p>
        </div>
      )}

      {result && (
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2 style={{ margin: 0 }}>{allOk ? 'GitHub is connected' : 'GitHub needs attention'}</h2>
            <span className={allOk ? 'badge ok' : 'badge bad'}>{allOk ? 'Connected' : 'Needs attention'}</span>
          </div>
          <ul className="gh-checks">
            {result.list.map((c, i) => (
              <li key={i}>
                <span className={c.ok === true ? 'gh-check ok' : c.ok === false ? 'gh-check bad' : 'gh-check info'} aria-label={c.ok === true ? 'Done' : c.ok === false ? 'Missing' : 'Note'}>{c.ok === true ? '✓' : c.ok === false ? '✕' : '–'}</span>
                <span>{c.text}{c.fix && <div style={{ marginTop: 6 }}>{c.fix}</div>}</span>
              </li>
            ))}
          </ul>
          <div className="row">
            {allOk && <Link className="btn primary" href="/admin/apps/new">Create an app</Link>}
            <ActionForm action={testGithubAction} submit="Test GitHub" busy="Asking GitHub…">{null}</ActionForm>
          </div>
        </div>
      )}
    </>
  )
}
