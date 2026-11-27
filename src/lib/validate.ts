import { extraReservedNames } from './settings'

// Shape checks shared by the forms and the engine. clubctl checks again on
// the sites VM, so these are for good error messages, not the last line.

export const RESERVED_NAMES = new Set([
  'www', 'admin', 'api', 'app', 'apps', 'mail', 'email', 'smtp', 'imap', 'pop', 'ftp', 'ssh', 'ns', 'ns1', 'ns2',
  'mx', 'dns', 'cdn', 'static', 'assets', 'media', 'files', 'img', 'images', 'blog', 'docs', 'help', 'support',
  'status', 'billing', 'account', 'accounts', 'login', 'signup', 'signin', 'register', 'auth', 'sso', 'dashboard',
  'console', 'deploy', 'deployer', 'postgres', 'caddy', 'base', 'test', 'demo', 'staging', 'dev', 'root', 'system', 'internal', 'localhost', 'webmail', 'portal', 'secure', 'pay',
])

/** Built-in names plus the ones added in Settings (Avrotech adds avro, avrotech, avrosphere). */
export function isReservedName(name: string): boolean {
  return RESERVED_NAMES.has(name) || extraReservedNames().has(name)
}

/** Site names double as the subdomain, the container name and the database name. */
export function clubNameError(name: string): string | null {
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(name)) return 'Use 2 to 31 lowercase letters, digits or hyphens, starting with a letter.'
  if (name.endsWith('-') || name.includes('--')) return "Hyphens can't be doubled or at the end."
  if (isReservedName(name)) return `"${name}" is kept for the platform's own addresses (like www, admin and api), so it can't be used.`
  return null
}

export function isDomain(s: string): boolean {
  return s.length <= 253 && /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(s)
}

export function isImage(s: string): boolean {
  return /^[a-z0-9][a-z0-9._/-]*(:[A-Za-z0-9._-]+)?(@sha256:[a-f0-9]{64})?$/.test(s)
}

export function isEmail(s: string): boolean {
  return s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)
}

/** Tidies what people paste: https://Example.com/ → example.com */
export function cleanDomain(input: string): string {
  return input.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '')
}

/** Extra settings box: KEY=value lines; returns the first problem or null. */
export function extraEnvError(text: string): string | null {
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (!line.trim() || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    const key = eq < 0 ? line : line.slice(0, eq)
    if (eq < 0 || !/^[A-Z][A-Z0-9_]*$/.test(key)) return `"${key.slice(0, 40)}" isn't a KEY=value line.`
    if (key.startsWith('CLUBCTL_')) return `${key} can't be set here.`
  }
  return null
}

/** Shown when a service needs a web address but no base domain is set yet. */
export const NO_BASE_DOMAIN = 'Set the domain services live under (Settings → Base domain) first, for example apps.example.com.'
