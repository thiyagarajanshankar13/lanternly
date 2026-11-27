import crypto from 'node:crypto'

// Time-based one-time codes (RFC 6238: SHA-1, 6 digits, 30 s), the kind every
// authenticator app reads.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(s: string): Buffer {
  let bits = 0, value = 0
  const out: number[] = []
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    const idx = B32.indexOf(ch)
    if (idx < 0) continue
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

export const newTotpSecret = () => base32Encode(crypto.randomBytes(20))

export function totpAt(secret: string, timeMs: number): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(timeMs / 30000)))
  const mac = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest()
  const offset = mac[mac.length - 1] & 15
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000
  return code.toString().padStart(6, '0')
}

/** Accepts the current code and one step either side (clock drift). */
export function verifyTotp(secret: string, code: string, timeMs = Date.now()): boolean {
  const clean = code.replace(/\s/g, '')
  if (!/^\d{6}$/.test(clean)) return false
  for (const step of [-1, 0, 1]) {
    const want = totpAt(secret, timeMs + step * 30000)
    if (crypto.timingSafeEqual(Buffer.from(want), Buffer.from(clean))) return true
  }
  return false
}

export function totpUri(secret: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`)
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`
}
