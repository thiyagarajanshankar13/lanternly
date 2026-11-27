// Apps: services built from a GitHub repo + branch (or a Docker image).
// Pure helpers (names, checks, the settings clubctl gets), easy to test.

export const APP_MEMORY_MIN = 64
export const APP_MEMORY_MAX = 4000

/** owner/name as GitHub shows it. */
export function repoError(repo: string, owner: string): string | null {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return 'Pick a repo (owner/name).'
  if (repo.split('/')[0].toLowerCase() !== owner.toLowerCase()) return `Only repos owned by ${owner} can be deployed.`
  return null
}

/** Git branch names, minus the odd shapes git itself refuses. */
export function branchError(branch: string): string | null {
  if (!branch) return 'Pick a branch.'
  if (branch.length > 200 || !/^[A-Za-z0-9._/-]+$/.test(branch)) return 'A branch name may only hold letters, digits and . _ / -'
  if (branch.startsWith('/') || branch.endsWith('/') || branch.endsWith('.') || branch.includes('..') || branch.includes('//') || branch.startsWith('-')) return "That isn't a valid branch name."
  return null
}

export function dockerfileError(path: string): string | null {
  if (!path) return null
  if (path.length > 200 || !/^[A-Za-z0-9._/-]+$/.test(path) || path.startsWith('/') || path.includes('..')) return 'The Dockerfile path must be a path inside the repo, like Dockerfile or web/Dockerfile.'
  return null
}

export function portError(port: number): string | null {
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? null : 'The port must be a number from 1 to 65535.'
}

export function healthPathError(path: string): string | null {
  if (path === '') return null // no health page: running is enough
  return /^\/[A-Za-z0-9._~/-]{0,200}$/.test(path) ? null : 'The health page must be a path like / or /health (no ? or spaces).'
}

/** The image the build workflow pushes for a commit. */
export function appImage(buildRepo: string, name: string, sha: string): string {
  const owner = buildRepo.split('/')[0].toLowerCase()
  return `ghcr.io/${owner}/app-${name}:${sha.slice(0, 12).toLowerCase()}`
}

/** The commit an app image was built from (its tag), or ''. */
export function shaOfImage(image: string): string {
  const tag = image.includes(':') ? image.slice(image.lastIndexOf(':') + 1) : ''
  return /^[0-9a-f]{7,40}$/.test(tag) ? tag : ''
}

const KEY = /^[A-Z_][A-Z0-9_]*$/

/** KEY=value lines (blank lines and # comments skipped). */
export function parseEnvLines(text: string): { env: Record<string, string>; error: string | null } {
  const env: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const eq = line.indexOf('=')
    const key = (eq < 0 ? line : line.slice(0, eq)).trim()
    if (eq < 0 || !KEY.test(key)) return { env, error: `"${key.slice(0, 40)}" isn't a KEY=value line.` }
    if (key.startsWith('CLUBCTL_')) return { env, error: `${key} can't be set here.` }
    if (key === 'PORT') return { env, error: 'PORT is set from the port above.' }
    env[key] = line.slice(eq + 1)
  }
  return { env, error: null }
}

/**
 * Secret settings: the box is never pre-filled, so lines in it add or replace
 * a saved value and "KEY=" with nothing after it removes one.
 */
export function mergeSecretEnv(previous: Record<string, string>, text: string): { env: Record<string, string>; error: string | null } {
  const { env: typed, error } = parseEnvLines(text)
  if (error) return { env: previous, error }
  const env = { ...previous }
  for (const [k, v] of Object.entries(typed)) {
    if (v === '') delete env[k]
    else env[k] = v
  }
  return { env, error: null }
}

export type AppForEnv = {
  extraEnv: string
  secrets: { appSecretEnv?: Record<string, string>; registryUser?: string; registryToken?: string }
  appPort: number
  appHealthPath: string
  memoryMb: number
}

/** What clubctl reads on stdin for an app: its settings, then clubctl's own lines. */
export function appSettingsText(app: AppForEnv): string {
  const env: Record<string, string> = { ...parseEnvLines(app.extraEnv).env, ...(app.secrets.appSecretEnv ?? {}) }
  const lines = Object.entries(env).map(([k, v]) => `${k}=${v.replace(/[\r\n]+/g, ' ')}`)
  // An empty health page = "running is enough" (images such as Redis don't answer web requests).
  lines.push(`CLUBCTL_MEMORY_MB=${app.memoryMb}`, `CLUBCTL_PORT=${app.appPort}`, `CLUBCTL_HEALTH_PATH=${app.appHealthPath || '-'}`)
  return lines.join('\n') + '\n'
}

/** Only for a pull (create, deploy): the sign-in for a private image. Never stored on the server. */
export function registryText(app: Pick<AppForEnv, 'secrets'>): string {
  const { registryUser, registryToken } = app.secrets
  if (!registryUser || !registryToken) return ''
  return `CLUBCTL_REGISTRY_USER=${registryUser}\nCLUBCTL_REGISTRY_TOKEN=${registryToken.replace(/[\r\n]+/g, '')}\n`
}

/** First line of a commit message, for lists. */
export function commitTitle(message: string): string {
  return (message.split('\n')[0] || '').trim().slice(0, 120)
}
