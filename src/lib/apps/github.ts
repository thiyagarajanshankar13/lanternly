import crypto from 'node:crypto'
import { isFakeEngine } from '../engine'
import { getSettings } from '../settings'

// The deployer talks to GitHub as a GitHub App: it lists the repos the App is
// installed on, reads branches, starts the build workflow and follows its run.
// Push notices come in on /api/github/webhook. With DEPLOYER_FAKE_ENGINE=1 a
// simulated GitHub answers instead (repos, branches and instant builds).

export const BUILD_WORKFLOW = 'build-app-image.yml'
const API = 'https://api.github.com'

export type Repo = { fullName: string; private: boolean; defaultBranch: string }
export type Commit = { sha: string; message: string; date: string; url: string }
export type Run = { id: number; url: string; status: 'queued' | 'in_progress' | 'completed' | string; conclusion: string | null }

export type GitHub = {
  listRepos(): Promise<Repo[]>
  listBranches(repo: string): Promise<string[]>
  branchHead(repo: string, branch: string): Promise<Commit>
  /** Starts the build workflow. Returns the run when GitHub says which one it is. */
  dispatchBuild(inputs: { app: string; repo: string; sha: string; dockerfile: string; request: string }): Promise<Run | null>
  /** Finds the run whose name carries the request id. */
  findRun(request: string): Promise<Run | null>
  getRun(id: number): Promise<Run>
}

/** Practice mode (DEPLOYER_FAKE_ENGINE) works without GitHub settings: these stand in. */
const FAKE_OWNER = 'example-org'

/** The GitHub organisation (or user) whose repos can be deployed. */
export function githubOwnerName(): string {
  return getSettings().githubOwner || (isFakeEngine() ? FAKE_OWNER : '')
}

/** owner/name of the repo that runs the build workflow. */
export function buildRepo(): string {
  return getSettings().githubBuildRepo || (isFakeEngine() ? `${FAKE_OWNER}/deployer` : '')
}

export function githubConfigured(): boolean {
  if (isFakeEngine()) return true
  const s = getSettings()
  return !!(s.githubAppId && s.githubPrivateKey && s.githubBuildRepo && s.githubOwner)
}

// ── The real one ─────────────────────────────────────────────────────────────
const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url')

/** The short-lived token that proves "I am this GitHub App" (RS256 JWT). */
export function appJwt(appId: string, privateKey: string, at = Date.now()): string {
  const iat = Math.floor(at / 1000) - 60
  const body = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({ iat, exp: iat + 540, iss: appId }))}`
  const sig = crypto.createSign('RSA-SHA256').update(body).sign(privateKey.replace(/\\n/g, '\n'))
  return `${body}.${b64url(sig)}`
}

const g = globalThis as unknown as { __ghToken?: { key: string; token: string; until: number } }

export class GitHubError extends Error {}

export async function call(path: string, init: RequestInit & { auth: string }): Promise<Response> {
  const res = await fetch(path.startsWith('http') ? path : `${API}${path}`, {
    ...init,
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'avro-deployer', ...(init.auth ? { Authorization: init.auth } : {}), ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(20_000),
  })
  return res
}

export async function fail(res: Response, what: string): Promise<never> {
  let detail = ''
  try { detail = ((await res.json()) as { message?: string }).message ?? '' } catch { /* not JSON */ }
  const hint = res.status === 401 ? ' Check the GitHub App ID and private key in Settings.'
    : res.status === 403 || res.status === 404 ? ' Check that the GitHub App is installed on that repo and has the permissions in the setup guide.' : ''
  throw new GitHubError(`GitHub refused to ${what} (${res.status}${detail ? `: ${detail}` : ''}).${hint}`)
}

/** The GitHub App the deployer signs in as: the saved one, or one being set up. */
export type AppCreds = { appId: string; privateKey: string; owner: string }

const savedCreds = (): AppCreds => { const s = getSettings(); return { appId: s.githubAppId, privateKey: s.githubPrivateKey, owner: s.githubOwner } }

/** Calls GitHub as the App itself (a JWT), e.g. to read its name or find its installation. */
export async function appCall(path: string, creds: AppCreds = savedCreds(), init: RequestInit = {}): Promise<Response> {
  if (!creds.appId || !creds.privateKey) throw new GitHubError('GitHub isn\'t set up yet: add the GitHub App under Settings.')
  let jwt: string
  try { jwt = appJwt(creds.appId, creds.privateKey) } catch { throw new GitHubError('The GitHub App private key in Settings can\'t be read. Paste the whole .pem file.') }
  return call(path, { ...init, auth: `Bearer ${jwt}` })
}

/** An installation token for the owner's installation, cached until shortly before it runs out. */
export async function installationToken(creds: AppCreds = savedCreds()): Promise<string> {
  const cacheKey = `${creds.appId}:${creds.owner}:${crypto.createHash('sha256').update(creds.privateKey).digest('hex').slice(0, 12)}`
  if (g.__ghToken && g.__ghToken.key === cacheKey && g.__ghToken.until > Date.now() + 120_000) return g.__ghToken.token
  let res = await appCall(`/orgs/${encodeURIComponent(creds.owner)}/installation`, creds)
  if (res.status === 404) res = await appCall(`/users/${encodeURIComponent(creds.owner)}/installation`, creds)
  if (!res.ok) await fail(res, `find the GitHub App's installation on ${creds.owner}`)
  const inst = await res.json() as { id: number }
  const tok = await appCall(`/app/installations/${inst.id}/access_tokens`, creds, { method: 'POST' })
  if (!tok.ok) await fail(tok, 'give the deployer a token')
  const body = await tok.json() as { token: string; expires_at: string }
  g.__ghToken = { key: cacheKey, token: body.token, until: new Date(body.expires_at).getTime() }
  return body.token
}

async function get<T>(path: string, what: string): Promise<T> {
  const res = await call(path, { auth: `token ${await installationToken()}` })
  if (!res.ok) await fail(res, what)
  return res.json() as Promise<T>
}

const toRun = (r: { id: number; html_url: string; status: string; conclusion: string | null }): Run => ({ id: r.id, url: r.html_url, status: r.status, conclusion: r.conclusion })

const realGitHub: GitHub = {
  async listRepos() {
    const owner = githubOwnerName().toLowerCase()
    const out: Repo[] = []
    for (let page = 1; page <= 10; page++) {
      const body = await get<{ repositories: { full_name: string; private: boolean; default_branch: string }[] }>(`/installation/repositories?per_page=100&page=${page}`, 'list the repos')
      for (const r of body.repositories) if (r.full_name.split('/')[0].toLowerCase() === owner) out.push({ fullName: r.full_name, private: r.private, defaultBranch: r.default_branch })
      if (body.repositories.length < 100) break
    }
    return out.sort((a, b) => a.fullName.localeCompare(b.fullName))
  },
  async listBranches(repo) {
    const out: string[] = []
    for (let page = 1; page <= 5; page++) {
      const body = await get<{ name: string }[]>(`/repos/${repo}/branches?per_page=100&page=${page}`, `list the branches of ${repo}`)
      out.push(...body.map((b) => b.name))
      if (body.length < 100) break
    }
    return out
  },
  async branchHead(repo, branch) {
    const b = await get<{ commit: { sha: string; html_url: string; commit: { message: string; committer?: { date?: string } } } }>(`/repos/${repo}/branches/${encodeURI(branch)}`, `read the branch ${branch} of ${repo}`)
    return { sha: b.commit.sha, message: b.commit.commit.message, date: b.commit.commit.committer?.date ?? '', url: b.commit.html_url }
  },
  async dispatchBuild(inputs) {
    const s = getSettings()
    const res = await call(`/repos/${s.githubBuildRepo}/actions/workflows/${BUILD_WORKFLOW}/dispatches`, {
      method: 'POST', auth: `token ${await installationToken()}`, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'main', inputs, return_run_details: true }),
    })
    if (!res.ok) await fail(res, `start the build workflow in ${s.githubBuildRepo}`)
    if (res.status === 204) return null
    const body = await res.json().catch(() => null) as { workflow_run_id?: number; html_url?: string } | null
    return body?.workflow_run_id ? { id: body.workflow_run_id, url: body.html_url ?? '', status: 'queued', conclusion: null } : null
  },
  async findRun(request) {
    const s = getSettings()
    const body = await get<{ workflow_runs: { id: number; html_url: string; status: string; conclusion: string | null; display_title?: string; name?: string }[] }>(
      `/repos/${s.githubBuildRepo}/actions/workflows/${BUILD_WORKFLOW}/runs?event=workflow_dispatch&per_page=50`, 'list the build runs')
    const hit = body.workflow_runs.find((r) => (r.display_title ?? r.name ?? '').includes(`(${request})`))
    return hit ? toRun(hit) : null
  },
  async getRun(id) {
    const s = getSettings()
    return toRun(await get(`/repos/${s.githubBuildRepo}/actions/runs/${id}`, 'read the build run'))
  },
}

// ── Simulated GitHub (DEPLOYER_FAKE_ENGINE=1) ────────────────────────────────
type FakeState = { pushes: Map<string, number>; runs: Map<number, { request: string; fail: boolean; polls: number }>; nextRun: number; failNext: boolean; slow: number }
const gf = globalThis as unknown as { __fakeGitHub?: FakeState }
export const fakeGitHub = () => (gf.__fakeGitHub ??= { pushes: new Map(), runs: new Map(), nextRun: 1000, failNext: false, slow: 0 })
const FAKE_REPOS: Repo[] = [
  { fullName: `${FAKE_OWNER}/static-site`, private: true, defaultBranch: 'main' },
  { fullName: `${FAKE_OWNER}/web-app`, private: true, defaultBranch: 'main' },
  { fullName: `${FAKE_OWNER}/deployer`, private: true, defaultBranch: 'main' },
]
const FAKE_BRANCHES: Record<string, string[]> = {
  [`${FAKE_OWNER}/static-site`]: ['main', 'campaign-site'],
  [`${FAKE_OWNER}/web-app`]: ['main', 'develop'],
  [`${FAKE_OWNER}/deployer`]: ['main'],
}
/** Tests: a new commit lands on a branch; returns its sha. */
export function fakePush(repo: string, branch: string): string {
  const f = fakeGitHub()
  const key = `${repo}#${branch}`
  f.pushes.set(key, (f.pushes.get(key) ?? 0) + 1)
  return fakeSha(repo, branch)
}
function fakeSha(repo: string, branch: string): string {
  return crypto.createHash('sha1').update(`${repo}#${branch}#${fakeGitHub().pushes.get(`${repo}#${branch}`) ?? 0}`).digest('hex')
}

const fakeGitHubClient: GitHub = {
  async listRepos() { return FAKE_REPOS },
  async listBranches(repo) {
    if (!FAKE_BRANCHES[repo]) throw new GitHubError(`GitHub refused to list the branches of ${repo} (404).`)
    return FAKE_BRANCHES[repo]
  },
  async branchHead(repo, branch) {
    if (!FAKE_BRANCHES[repo]?.includes(branch)) throw new GitHubError(`GitHub refused to read the branch ${branch} of ${repo} (404: Branch not found).`)
    const n = fakeGitHub().pushes.get(`${repo}#${branch}`) ?? 0
    const sha = fakeSha(repo, branch)
    return { sha, message: n ? `Change number ${n} on ${branch}` : `Latest work on ${branch}`, date: new Date().toISOString(), url: `https://github.com/${repo}/commit/${sha}` }
  },
  async dispatchBuild(inputs) {
    const f = fakeGitHub()
    const id = f.nextRun++
    f.runs.set(id, { request: inputs.request, fail: f.failNext, polls: 0 })
    f.failNext = false
    return { id, url: `https://github.com/${buildRepo()}/actions/runs/${id}`, status: 'queued', conclusion: null }
  },
  async findRun(request) {
    for (const [id, r] of fakeGitHub().runs) if (r.request === request) return this.getRun(id)
    return null
  },
  async getRun(id) {
    const f = fakeGitHub()
    const r = f.runs.get(id)
    if (!r) throw new GitHubError('GitHub refused to read the build run (404).')
    r.polls++
    const url = `https://github.com/${buildRepo()}/actions/runs/${id}`
    if (r.polls <= f.slow) return { id, url, status: 'in_progress', conclusion: null }
    return { id, url, status: 'completed', conclusion: r.fail ? 'failure' : 'success' }
  },
}

export const github = (): GitHub => (isFakeEngine() ? fakeGitHubClient : realGitHub)

/** Checks a push notice's signature (X-Hub-Signature-256) against the webhook secret. */
export function validSignature(body: string, header: string | null, secret: string): boolean {
  if (!secret || !header || !header.startsWith('sha256=')) return false
  const want = Buffer.from(crypto.createHmac('sha256', secret).update(body).digest('hex'))
  const got = Buffer.from(header.slice(7))
  return want.length === got.length && crypto.timingSafeEqual(want, got)
}
