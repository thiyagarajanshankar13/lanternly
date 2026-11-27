import crypto from 'node:crypto'

// AES-256-GCM for the secrets the deployer stores (club Square/SMTP keys,
// two-step secrets, queued operation payloads). Key: DEPLOYER_SECRET_KEY.
function key(): Buffer {
  const hex = (process.env.DEPLOYER_SECRET_KEY || '').trim()
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('DEPLOYER_SECRET_KEY must be 64 hex characters (openssl rand -hex 32)')
  }
  return Buffer.from(hex, 'hex')
}

export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv)
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), body.toString('base64')].join(':')
}

export function decrypt(stored: string): string {
  const [v, iv, tag, body] = stored.split(':')
  if (v !== 'v1' || !iv || !tag || body === undefined) throw new Error('Unreadable encrypted value')
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'))
  decipher.setAuthTag(Buffer.from(tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8')
}

export function encryptJson(value: unknown): string {
  return encrypt(JSON.stringify(value))
}
export function decryptJson<T>(stored: string, fallback: T): T {
  if (!stored) return fallback
  return JSON.parse(decrypt(stored)) as T
}

export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex')
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url')

/** A password people can type: 16 characters, no look-alikes. */
export function randomPassword(length = 16): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
  let out = ''
  while (out.length < length) {
    const b = crypto.randomBytes(1)[0]
    if (b < alphabet.length * 4) out += alphabet[b % alphabet.length]
  }
  return out
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 })
  return `scrypt:${salt.toString('base64')}:${hash.toString('base64')}`
}
export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split(':')
  if (scheme !== 'scrypt' || !salt || !hash) return false
  const want = Buffer.from(hash, 'base64')
  const got = crypto.scryptSync(password, Buffer.from(salt, 'base64'), want.length, { N: 16384, r: 8, p: 1 })
  return crypto.timingSafeEqual(want, got)
}

/** A stable secret derived from the deployer's key, e.g. a site's stats key. Never stored. */
export function derivedSecret(purpose: string): string {
  return crypto.createHmac('sha256', key()).update(purpose).digest('base64url')
}
