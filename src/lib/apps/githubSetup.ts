import crypto from 'node:crypto'
import nacl from 'tweetnacl'
import { blake2b } from 'blakejs'
import { deployerUrl } from '../deployerUrl'
import { getSettings, saveSettings } from '../settings'
import { type AppCreds, GitHubError, appCall, call, fail, installationToken } from './github'

// "Create GitHub app": the deployer registers its own GitHub App through
// GitHub's app manifest flow instead of an owner creating one by hand.
//
//   1. prepareManifest() makes the manifest and a one-time state; the browser
//      posts it to github.com/…/settings/apps/new, where the owner confirms.
//   2. GitHub sends them back to /admin/github-setup/created?code=…&state=…;
//      convertManifest() swaps the code for the App's ID, key and webhook
//      secret, kept as the *pending* app, and they go on to install it.
//   3. After installing, GitHub sends them to /admin/github-setup/installed;
//      finishInstall() switches over to the new app only once it can see its
//      installation (so a working app is never replaced by a half-made one)
//      and saves the build repo's Actions secrets for the build workflow.

/** Repository permissions the deployer's GitHub App asks for. */
export const APP_PERMISSIONS = { contents: 'read', metadata: 'read', actions: 'write', secrets: 'write' } as const
/** The Actions secrets the build workflow signs in with (.github/workflows/build-app-image.yml). */
export const BUILD_SECRET_ID = 'APPS_GITHUB_APP_ID'
export const BUILD_SECRET_KEY = 'APPS_GITHUB_APP_KEY'
const STATE_MINUTES = 60

export type PendingApp = { id: string; slug: string; name: string; pem: string; webhookSecret: string; owner: string; buildRepo: string; htmlUrl: string }

export function ownerError(owner: string): string | null {
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner) ? null : 'Enter the GitHub organisation or user, like my-company.'
}
export function buildRepoError(repo: string, owner: string): string | null {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return 'Enter the deployer repo as owner/name.'
  if (repo.split('/')[0].toLowerCase() !== owner.toLowerCase()) return `The build repo must belong to ${owner}: builds only take repos of their own owner.`
  return null
}

/** A GitHub App name (34 characters at most, unique on GitHub; the owner can change it on GitHub's page). */
export function appName(brand: string, owner: string): string {
  const full = `${brand || 'Deployer'} (${owner})`
  return full.length <= 34 ? full : `${brand || 'Deployer'}`.slice(0, 34).trim()
}

/** Whether GitHub can reach this deployer for push notices (not on a laptop). */
export function webhookReachable(url = deployerUrl()): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && !/^(localhost|127\.|10\.|192\.168\.|\[?::1)/.test(u.hostname) && !u.hostname.endsWith('.local')
  } catch { return false }
}

export function manifestFor(owner: string, base = deployerUrl(), brand = getSettings().brandName) {
  return {
    name: appName(brand, owner),
    url: base,
    description: `Builds and deploys apps from ${owner}'s repos for ${base.replace(/^https?:\/\//, '')}.`,
    hook_attributes: { url: `${base}/api/github/webhook`, active: webhookReachable(base) },
    redirect_url: `${base}/admin/github-setup/created`,
    setup_url: `${base}/admin/github-setup/installed`,
    setup_on_update: true,
    public: false,
    default_permissions: { ...APP_PERMISSIONS },
    default_events: ['push'],
  }
}

/** Where the browser posts the manifest: the organisation's new-app page, or the user's. */
export function newAppUrl(owner: string, isOrg: boolean, state: string): string {
  const q = `?state=${encodeURIComponent(state)}`
  return isOrg ? `https://github.com/organizations/${encodeURIComponent(owner)}/settings/apps/new${q}` : `https://github.com/settings/apps/new${q}`
}

/** Organisation or personal account (GitHub's public profile says). Unknown = organisation. */
export async function ownerIsOrg(owner: string): Promise<boolean> {
  try {
    const res = await fetch(`https://api.github.com/users/${encodeURIComponent(owner)}`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'deployer' }, signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return true
    return ((await res.json()) as { type?: string }).type !== 'User'
  } catch { return true }
}

/** Step 1: the manifest, the address to post it to, and a one-time state remembered for the way back. */
export async function prepareManifest(owner: string, buildRepo: string, at = Date.now()) {
  const state = crypto.randomBytes(24).toString('base64url')
  saveSettings({ githubSetupState: `${state} ${at + STATE_MINUTES * 60_000} ${owner} ${buildRepo}` })
  return { url: newAppUrl(owner, await ownerIsOrg(owner), state), manifest: JSON.stringify(manifestFor(owner)) }
}

/** The owner and build repo the state was made for, or null when it doesn't match or has run out. Used once. */
export function takeState(state: string, at = Date.now()): { owner: string; buildRepo: string } | null {
  const [want, until, owner, buildRepo] = getSettings().githubSetupState.split(' ')
  if (!want || !state) return null
  const a = Buffer.from(want), b = Buffer.from(state)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b) || Number(until) < at) return null
  saveSettings({ githubSetupState: '' })
  return { owner, buildRepo }
}

/** Step 2: swaps GitHub's one-time code for the new App's ID, key and webhook secret. */
export async function convertManifest(code: string, owner: string, buildRepo: string): Promise<PendingApp> {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(code)) throw new GitHubError('GitHub sent back a code the deployer can\'t use. Start again.')
  const res = await call(`/app-manifests/${code}/conversions`, { method: 'POST', auth: '' })
  if (!res.ok) await fail(res, 'hand over the new GitHub App')
  const b = await res.json() as { id: number; slug: string; name: string; pem: string; webhook_secret: string | null; html_url: string; owner?: { login?: string } }
  const app: PendingApp = {
    id: String(b.id), slug: b.slug, name: b.name, pem: b.pem, webhookSecret: b.webhook_secret ?? '',
    owner: b.owner?.login || owner, buildRepo, htmlUrl: b.html_url,
  }
  saveSettings({ githubPendingApp: JSON.stringify(app) })
  return app
}

export function pendingApp(): PendingApp | null {
  const raw = getSettings().githubPendingApp
  if (!raw) return null
  try { return JSON.parse(raw) as PendingApp } catch { return null }
}
export function discardPendingApp() { saveSettings({ githubPendingApp: '' }) }

export const installUrl = (slug: string) => `https://github.com/apps/${encodeURIComponent(slug)}/installations/new`

const credsOf = (p: PendingApp): AppCreds => ({ appId: p.id, privateKey: p.pem, owner: p.owner })

export type FinishResult = { switched: boolean; secrets: 'saved' | 'no-permission' | 'failed' | 'skipped'; detail?: string }

/**
 * Step 3: once the pending app is installed on its owner, it becomes the app
 * the deployer uses; then the build repo gets its Actions secrets.
 */
export async function finishInstall(): Promise<FinishResult> {
  const p = pendingApp()
  let switched = false
  if (p) {
    await installationToken(credsOf(p)) // throws when it isn't installed on the owner (yet)
    saveSettings({
      githubAppId: p.id, githubPrivateKey: p.pem, githubWebhookSecret: p.webhookSecret, githubOwner: p.owner, githubBuildRepo: p.buildRepo,
      githubAppSlug: p.slug, githubAppName: p.name, githubPendingApp: '', githubBuildSecretsFor: '',
    })
    switched = true
  }
  const s = getSettings()
  if (!s.githubAppId || !s.githubPrivateKey) return { switched, secrets: 'skipped' }
  if (s.githubBuildSecretsFor === `${s.githubAppId} ${s.githubBuildRepo}` && !switched) return { switched, secrets: 'saved' }
  return { switched, ...(await saveBuildSecrets()) }
}

/** What the saved GitHub App is called and may do (and remembers its name for Settings). */
export async function appInfo(): Promise<{ slug: string; name: string; htmlUrl: string; permissions: Record<string, string> }> {
  const res = await appCall('/app')
  if (!res.ok) await fail(res, 'describe the GitHub App')
  const b = await res.json() as { slug: string; name: string; html_url: string; permissions?: Record<string, string> }
  const s = getSettings()
  if (s.githubAppSlug !== b.slug || s.githubAppName !== b.name) saveSettings({ githubAppSlug: b.slug, githubAppName: b.name })
  return { slug: b.slug, name: b.name, htmlUrl: b.html_url, permissions: b.permissions ?? {} }
}

/** Saves the App's ID and key as the build repo's Actions secrets, so the build workflow can check out private repos. */
export async function saveBuildSecrets(): Promise<{ secrets: 'saved' | 'no-permission' | 'failed'; detail?: string }> {
  const s = getSettings()
  try {
    const token = await installationToken()
    const auth = `token ${token}`
    const keyRes = await call(`/repos/${s.githubBuildRepo}/actions/secrets/public-key`, { auth })
    if (keyRes.status === 403) return { secrets: 'no-permission' }
    if (!keyRes.ok) await fail(keyRes, `read ${s.githubBuildRepo}'s secrets key`)
    const { key_id, key } = await keyRes.json() as { key_id: string; key: string }
    for (const [name, value] of [[BUILD_SECRET_ID, s.githubAppId], [BUILD_SECRET_KEY, s.githubPrivateKey]] as const) {
      const put = await call(`/repos/${s.githubBuildRepo}/actions/secrets/${name}`, {
        method: 'PUT', auth, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ encrypted_value: sealFor(key, value), key_id }),
      })
      if (put.status === 403) return { secrets: 'no-permission' }
      if (!put.ok) await fail(put, `save the ${name} secret in ${s.githubBuildRepo}`)
    }
    saveSettings({ githubBuildSecretsFor: `${s.githubAppId} ${s.githubBuildRepo}` })
    return { secrets: 'saved' }
  } catch (err) {
    return { secrets: 'failed', detail: (err as Error).message }
  }
}

/** libsodium's sealed box (what GitHub wants for secrets): anonymous X25519 + XSalsa20-Poly1305, base64. */
export function sealFor(publicKeyB64: string, message: string): string {
  const pk = Buffer.from(publicKeyB64, 'base64')
  if (pk.length !== nacl.box.publicKeyLength) throw new GitHubError('GitHub sent a secrets key the deployer can\'t use.')
  const eph = nacl.box.keyPair()
  const nonce = blake2b(Buffer.concat([Buffer.from(eph.publicKey), pk]), undefined, nacl.box.nonceLength)
  const boxed = nacl.box(Buffer.from(message, 'utf8'), nonce, pk, eph.secretKey)
  return Buffer.concat([Buffer.from(eph.publicKey), Buffer.from(boxed)]).toString('base64')
}
