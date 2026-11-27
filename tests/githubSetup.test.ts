import crypto from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import _sodium from 'libsodium-wrappers'
import { getSettings, saveSettings } from '@/lib/settings'
import {
  APP_PERMISSIONS, appName, buildRepoError, convertManifest, finishInstall, manifestFor, newAppUrl, ownerError, pendingApp,
  prepareManifest, sealFor, takeState, webhookReachable,
} from '@/lib/apps/githubSetup'
import { freshEnv } from './setup'

const { privateKey: PEM } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })

type Handler = (url: string, init: RequestInit) => { status: number; body?: unknown } | undefined
function stubFetch(handler: Handler) {
  const calls: { url: string; init: RequestInit }[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init })
    const r = handler(url, init) ?? { status: 404, body: { message: 'Not Found' } }
    return new Response(r.status === 204 ? null : JSON.stringify(r.body ?? {}), { status: r.status, headers: { 'Content-Type': 'application/json' } })
  })
  return calls
}

beforeEach(() => {
  freshEnv()
  delete process.env.DEPLOYER_FAKE_ENGINE
  process.env.DEPLOYER_URL = 'https://deploy.example.com'
  ;(globalThis as { __ghToken?: unknown }).__ghToken = undefined
})
afterEach(() => { vi.unstubAllGlobals(); delete process.env.DEPLOYER_URL })

describe('the app manifest', () => {
  it('asks for the permissions builds need, with this deployer\'s addresses', () => {
    const m = manifestFor('acme', 'https://deploy.example.com', 'Deployer')
    expect(m.name).toBe('Deployer (acme)')
    expect(m.default_permissions).toEqual(APP_PERMISSIONS)
    expect(m.default_permissions).toMatchObject({ contents: 'read', actions: 'write', secrets: 'write' })
    expect(m.default_events).toEqual(['push'])
    expect(m.hook_attributes).toEqual({ url: 'https://deploy.example.com/api/github/webhook', active: true })
    expect(m.redirect_url).toBe('https://deploy.example.com/admin/github-setup/created')
    expect(m.setup_url).toBe('https://deploy.example.com/admin/github-setup/installed')
    expect(m.public).toBe(false)
  })
  it('switches the webhook off where GitHub can\'t reach it', () => {
    expect(webhookReachable('http://localhost:3100')).toBe(false)
    expect(webhookReachable('https://192.168.1.4')).toBe(false)
    expect(webhookReachable('https://admin.avro.site')).toBe(true)
    expect(manifestFor('acme', 'http://localhost:3100', 'D').hook_attributes.active).toBe(false)
  })
  it('keeps names within GitHub\'s 34 characters', () => {
    expect(appName('Deployer', 'a-very-long-organisation-name-here').length).toBeLessThanOrEqual(34)
    expect(appName('', 'acme')).toBe('Deployer (acme)')
  })
  it('posts to the organisation page or the personal one', () => {
    expect(newAppUrl('acme', true, 's1')).toBe('https://github.com/organizations/acme/settings/apps/new?state=s1')
    expect(newAppUrl('jo', false, 's1')).toBe('https://github.com/settings/apps/new?state=s1')
  })
  it('checks the owner and build repo', () => {
    expect(ownerError('acme-co')).toBeNull()
    expect(ownerError('-bad')).not.toBeNull()
    expect(buildRepoError('acme/deployer', 'acme')).toBeNull()
    expect(buildRepoError('other/deployer', 'acme')).toMatch(/belong to acme/)
    expect(buildRepoError('nope', 'acme')).toMatch(/owner\/name/)
  })
})

describe('the trip to GitHub and back', () => {
  it('gives a one-time state that runs out', async () => {
    stubFetch((url) => url.endsWith('/users/acme') ? { status: 200, body: { type: 'Organization' } } : undefined)
    const t0 = Date.now()
    const { url, manifest } = await prepareManifest('acme', 'acme/deployer', t0)
    expect(url).toMatch(/^https:\/\/github\.com\/organizations\/acme\/settings\/apps\/new\?state=/)
    expect(JSON.parse(manifest).name).toContain('acme')
    const state = decodeURIComponent(url.split('state=')[1])
    expect(takeState('wrong', t0)).toBeNull()
    expect(takeState(state, t0 + 61 * 60_000)).toBeNull()
    expect(takeState(state, t0)).toEqual({ owner: 'acme', buildRepo: 'acme/deployer' })
    expect(takeState(state, t0)).toBeNull() // used once
  })

  it('keeps the new app aside until it is installed, then switches and saves the build secrets', async () => {
    await _sodium.ready
    const sodium = _sodium
    const repoKeys = sodium.crypto_box_keypair()
    saveSettings({ githubAppId: '111', githubPrivateKey: 'old-key', githubOwner: 'acme', githubBuildRepo: 'acme/deployer', githubWebhookSecret: 'old-secret-old-secret' })
    let installed = false
    const secrets: Record<string, string> = {}
    const calls = stubFetch((url, init) => {
      if (url.endsWith('/app-manifests/code123/conversions')) return { status: 201, body: { id: 222, slug: 'deployer-acme', name: 'Deployer (acme)', pem: PEM, webhook_secret: 'new-webhook-secret-123', html_url: 'https://github.com/apps/deployer-acme', owner: { login: 'acme' } } }
      if (url.endsWith('/orgs/acme/installation')) return installed ? { status: 200, body: { id: 9 } } : { status: 404, body: { message: 'Not Found' } }
      if (url.endsWith('/users/acme/installation')) return { status: 404, body: { message: 'Not Found' } }
      if (url.endsWith('/app/installations/9/access_tokens')) return { status: 201, body: { token: 'ghs_x', expires_at: new Date(Date.now() + 3600_000).toISOString() } }
      if (url.endsWith('/repos/acme/deployer/actions/secrets/public-key')) return { status: 200, body: { key_id: 'k1', key: Buffer.from(repoKeys.publicKey).toString('base64') } }
      const m = url.match(/\/repos\/acme\/deployer\/actions\/secrets\/(\w+)$/)
      if (m && init.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as { encrypted_value: string; key_id: string }
        expect(body.key_id).toBe('k1')
        secrets[m[1]] = Buffer.from(sodium.crypto_box_seal_open(Buffer.from(body.encrypted_value, 'base64'), repoKeys.publicKey, repoKeys.privateKey)).toString('utf8')
        return { status: 201 }
      }
      return undefined
    })

    await convertManifest('code123', 'acme', 'acme/deployer')
    expect(calls[0].init.headers).not.toHaveProperty('Authorization')
    expect(pendingApp()?.id).toBe('222')
    expect(getSettings().githubAppId).toBe('111') // the working app stays until the new one is installed

    await expect(finishInstall()).rejects.toThrow(/installation/)
    expect(getSettings().githubAppId).toBe('111')

    installed = true
    const r = await finishInstall()
    expect(r).toEqual({ switched: true, secrets: 'saved' })
    const s = getSettings()
    expect(s).toMatchObject({ githubAppId: '222', githubAppSlug: 'deployer-acme', githubWebhookSecret: 'new-webhook-secret-123', githubPendingApp: '', githubBuildSecretsFor: '222 acme/deployer' })
    expect(s.githubPrivateKey).toBe(PEM)
    expect(secrets).toEqual({ APPS_GITHUB_APP_ID: '222', APPS_GITHUB_APP_KEY: PEM })

    // Changing the repos later doesn't save the secrets again.
    const before = calls.length
    expect(await finishInstall()).toEqual({ switched: false, secrets: 'saved' })
    expect(calls.length).toBe(before)
  })

  it('says so when the app may not change secrets', async () => {
    saveSettings({ githubAppId: '111', githubPrivateKey: PEM, githubOwner: 'acme', githubBuildRepo: 'acme/deployer' })
    stubFetch((url) => {
      if (url.endsWith('/orgs/acme/installation')) return { status: 200, body: { id: 9 } }
      if (url.endsWith('/access_tokens')) return { status: 201, body: { token: 'ghs_x', expires_at: new Date(Date.now() + 3600_000).toISOString() } }
      if (url.endsWith('/secrets/public-key')) return { status: 403, body: { message: 'Resource not accessible by integration' } }
      return undefined
    })
    expect(await finishInstall()).toEqual({ switched: false, secrets: 'no-permission' })
    expect(getSettings().githubBuildSecretsFor).toBe('')
  })
})

describe('sealed secrets', () => {
  it('opens with libsodium', async () => {
    await _sodium.ready
    const kp = _sodium.crypto_box_keypair()
    const sealed = sealFor(Buffer.from(kp.publicKey).toString('base64'), 'hello ✓')
    expect(Buffer.from(_sodium.crypto_box_seal_open(Buffer.from(sealed, 'base64'), kp.publicKey, kp.privateKey)).toString('utf8')).toBe('hello ✓')
  })
})
