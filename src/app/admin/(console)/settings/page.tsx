import Link from 'next/link'
import { requireOwner } from '@/lib/guards'
import { getSettings } from '@/lib/settings'
import { PLUGINS, enabledPlugins } from '@/plugins'
import { ActionForm } from '@/components/ActionForm'
import { Popup, Toolbar } from '@/components/Popup'
import { saveBrandingAction, saveSettingsAction } from '../actions'
import { saveGithubSettingsAction, testGithubAction } from '../apps/actions'
import { installUrl, pendingApp } from '@/lib/apps/githubSetup'

export const metadata = { title: 'Settings' }

export default async function SettingsPage() {
  await requireOwner()
  const s = getSettings()
  const plugins = enabledPlugins()
  const pending = pendingApp()
  return (
    <>
      <div className="page-head">
        <div><h1>Settings</h1><p className="muted">Defaults for every service.</p></div>
        <Toolbar>
          <Popup label="Branding" short="Branding" title="Branding and region" subtitle="The deployer's name and logo, and how it writes dates." icon="edit" panel>
            <ActionForm action={saveBrandingAction} submit="Save">
              <div className="grid cols-2">
                <div className="field"><label htmlFor="brandName">Name</label><input id="brandName" name="brandName" type="text" maxLength={40} defaultValue={s.brandName} required /><div className="help">Side menu, sign-in page and the authenticator app.</div></div>
                <div className="field"><label htmlFor="brandTagline">Line under the name (optional)</label><input id="brandTagline" name="brandTagline" type="text" maxLength={60} defaultValue={s.brandTagline} /><div className="help">Also ends every page title.</div></div>
                <div className="field"><label htmlFor="brandLogoUrl">Logo address (optional)</label><input id="brandLogoUrl" name="brandLogoUrl" type="text" defaultValue={s.brandLogoUrl} placeholder="https://example.com/logo.png" /><div className="help">Empty shows the built-in mark.</div></div>
                <div className="field"><label htmlFor="locale">Locale</label><input id="locale" name="locale" type="text" defaultValue={s.locale} placeholder="en-US" /><div className="help">How dates are written: en-US, en-GB, en-AU…</div></div>
              </div>
              <div className="field"><label htmlFor="extraReservedNames">More reserved names (optional)</label><input id="extraReservedNames" name="extraReservedNames" type="text" defaultValue={s.extraReservedNames} placeholder="mycompany myproduct" />
                <div className="help">Names no service may take, on top of www, admin, api and the like. Separate with spaces.</div></div>
            </ActionForm>
          </Popup>
          <Popup label="GitHub apps" short="GitHub" title="GitHub apps by hand" subtitle="For a GitHub App you made yourself. Connect GitHub on the GitHub page does all of this for you." icon="rocket" panel>
            <ActionForm action={saveGithubSettingsAction} submit="Save">
              <p className="muted small">Follow “Setting up apps by hand” in the deployer&apos;s setup guide. The private key and webhook secret are stored encrypted.</p>
              <div className="grid cols-2">
                <div className="field"><label htmlFor="githubAppId">App ID</label><input id="githubAppId" name="githubAppId" type="text" inputMode="numeric" defaultValue={s.githubAppId} /></div>
                <div className="field"><label htmlFor="githubOwner">GitHub organisation</label><input id="githubOwner" name="githubOwner" type="text" defaultValue={s.githubOwner} required /><div className="help">Only its repos can be deployed.</div></div>
                <div className="field"><label htmlFor="githubBuildRepo">Builds run in</label><input id="githubBuildRepo" name="githubBuildRepo" type="text" defaultValue={s.githubBuildRepo} required /><div className="help">The deployer&apos;s own repo (it holds the build workflow).</div></div>
                <div className="field"><label htmlFor="appDefaultMemoryMb">Memory limit per app (MB)</label><input id="appDefaultMemoryMb" name="appDefaultMemoryMb" type="number" min={64} max={4000} defaultValue={s.appDefaultMemoryMb} required /></div>
              </div>
              <div className="field"><label htmlFor="githubPrivateKey">Private key (.pem)</label><textarea id="githubPrivateKey" name="githubPrivateKey" spellCheck={false} autoComplete="off" placeholder={s.githubPrivateKey ? 'Saved. Paste a new key to replace it' : '-----BEGIN RSA PRIVATE KEY-----'} /></div>
              <div className="field"><label htmlFor="githubWebhookSecret">Webhook secret</label><input id="githubWebhookSecret" name="githubWebhookSecret" type="password" autoComplete="new-password" placeholder={s.githubWebhookSecret ? 'Saved. Type to replace' : ''} />
                <div className="help">The same text as the GitHub App&apos;s webhook secret. Its webhook address is <code>https://&lt;this deployer&gt;/api/github/webhook</code>.</div></div>
            </ActionForm>
          </Popup>
          <Popup label="Edit settings" short="Edit" title="Settings" subtitle="Defaults for every service." icon="edit" primary panel>
        <ActionForm action={saveSettingsAction} submit="Save settings">
          <h2>Addresses</h2>
          <div className="grid cols-2">
            <div className="field"><label htmlFor="baseDomain">Domain services live under</label><input id="baseDomain" name="baseDomain" type="text" defaultValue={s.baseDomain} placeholder="apps.example.com" required /><div className="help">A site named <code>riverside</code> gets <code>riverside.{s.baseDomain || 'apps.example.com'}</code>. Needs a wildcard DNS record pointing at the sites server.</div></div>
            <div className="field"><label htmlFor="defaultTimezone">Default time zone</label><input id="defaultTimezone" name="defaultTimezone" type="text" defaultValue={s.defaultTimezone} /></div>
          </div>

          <h2 style={{ marginTop: 8 }}>Outgoing email for sites</h2>
          <p className="muted">Sites send their emails (invoices, welcome, password reset) through this account, under their own name.</p>
          <div className="grid cols-2">
            <div className="field"><label htmlFor="smtpHost">SMTP server</label><input id="smtpHost" name="smtpHost" type="text" defaultValue={s.smtpHost} /></div>
            <div className="field"><label htmlFor="smtpPort">Port</label><input id="smtpPort" name="smtpPort" type="text" defaultValue={s.smtpPort} /></div>
            <div className="field"><label htmlFor="smtpUser">Username</label><input id="smtpUser" name="smtpUser" type="text" defaultValue={s.smtpUser} autoComplete="off" /></div>
            <div className="field"><label htmlFor="smtpPass">Password</label><input id="smtpPass" name="smtpPass" type="password" autoComplete="new-password" placeholder={s.smtpPass ? 'Saved. Type to replace' : ''} /></div>
            <div className="field"><label htmlFor="smtpFromAddress">Sender address</label><input id="smtpFromAddress" name="smtpFromAddress" type="email" defaultValue={s.smtpFromAddress} placeholder={`no-reply@${s.baseDomain || 'example.com'}`} /></div>
          </div>
        </ActionForm>
          </Popup>
        </Toolbar>
      </div>
      <div className="grid cols-2">
        <div className="card">
          <h2>Addresses</h2>
          <dl className="summary">
            <dt>Domain services live under</dt><dd>{s.baseDomain ? <code>{s.baseDomain}</code> : <strong>Not set yet: press Edit settings</strong>}</dd>
            <dt>Default time zone</dt><dd>{s.defaultTimezone}</dd>
          </dl>
        </div>
        <div className="card">
          <h2>Outgoing email for sites</h2>
          {s.smtpHost ? (
            <dl className="summary">
              <dt>SMTP server</dt><dd><code>{s.smtpHost}:{s.smtpPort}</code></dd>
              <dt>Username</dt><dd>{s.smtpUser || 'None'}</dd>
              <dt>Password</dt><dd>{s.smtpPass ? 'Saved' : 'Not set'}</dd>
              <dt>Sender address</dt><dd>{s.smtpFromAddress || `no-reply@${s.baseDomain}`}</dd>
            </dl>
          ) : <p className="muted">Not set up yet. Sites can&apos;t send emails until it is: press <strong>Edit settings</strong>.</p>}
        </div>
      </div>

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>GitHub apps</h2>
          {s.githubAppId && s.githubPrivateKey ? <span className="badge ok">Connected</span> : pending ? <span className="badge warn">Waiting to be installed</span> : <span className="badge warn">Not connected</span>}
        </div>
        {s.githubAppId && s.githubPrivateKey ? (
          <>
            <dl className="summary" style={{ marginTop: 10 }}>
              <dt>GitHub App</dt><dd>{s.githubAppName || `ID ${s.githubAppId}`}</dd>
              <dt>Repos from</dt><dd><code>{s.githubOwner}</code></dd>
              <dt>Builds run in</dt><dd><code>{s.githubBuildRepo}</code></dd>
              <dt>Pushes deploy apps</dt><dd>{s.githubWebhookSecret ? 'Yes' : 'No (no webhook secret: apps only deploy when you press Deploy latest)'}</dd>
              <dt>Memory limit per app</dt><dd>{s.appDefaultMemoryMb} MB</dd>
            </dl>
            <div className="row">
              {s.githubAppSlug && <a className="btn" href={installUrl(s.githubAppSlug)}>Add repos</a>}
              <Link className="btn" href="/admin/settings/github">Check the connection</Link>
              <ActionForm action={testGithubAction} submit="Test GitHub" busy="Asking GitHub…">{null}</ActionForm>
            </div>
          </>
        ) : (
          <>
            <p className="muted">Deploy apps from your GitHub repos. The deployer creates its own GitHub App for you: no keys to copy.</p>
            <div className="row">
              <Link className="btn primary" href="/admin/settings/github">{pending ? 'Finish connecting GitHub' : 'Connect GitHub'}</Link>
            </div>
          </>
        )}
      </div>

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>Plugins</h2>
          <Link className="btn" href="/admin/settings/plugins">Manage plugins</Link>
        </div>
        <dl className="summary" style={{ marginTop: 10 }}>
          {PLUGINS.map((p) => (
            <div key={p.id} style={{ display: 'contents' }}>
              <dt>{p.name}</dt>
              <dd>{plugins.has(p.id) ? <>On{p.settingsHref && <> · <Link href={p.settingsHref}>its settings</Link></>}</> : 'Off'}</dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="card">
        <h2>Branding and region</h2>
        <dl className="summary">
          <dt>Name</dt><dd>{s.brandName}{s.brandTagline ? <span className="muted"> · {s.brandTagline}</span> : null}</dd>
          <dt>Logo</dt><dd>{s.brandLogoUrl ? <code>{s.brandLogoUrl}</code> : 'Built-in mark'}</dd>
          <dt>Locale</dt><dd>{s.locale}</dd>
          <dt>More reserved names</dt><dd>{s.extraReservedNames || 'None'}</dd>
        </dl>
      </div>

      <div className="card">
        <h2>People</h2>
        <p className="muted" style={{ margin: 0 }}>Who can sign in to the deployer, and which sites they can see, is under <Link href="/admin/people">People</Link>.</p>
      </div>
    </>
  )
}
