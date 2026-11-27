import crypto from 'node:crypto'
import { Transform, type TransformCallback } from 'node:stream'

// Everything the deployer puts in the bucket is encrypted first, with the
// backup key (Settings > Backups), never the deployer's own secret key: the
// backup key is shown to the admin once so backups can still be read if the
// deployer is lost (scripts/backup-tool.mjs).
//
// Format "AVB1": a 16-byte header (magic, 4 random nonce bytes, 8 bytes of the
// key's fingerprint), then chunks of up to 1 MiB, each AES-256-GCM with its own
// 12-byte nonce (the 4 random bytes + the chunk number) and the chunk number +
// a "last chunk" flag as associated data, so chunks can't be reordered,
// dropped or cut off without the read failing.
//   chunk = u32 plaintext length · u8 last · ciphertext · 16-byte tag

const MAGIC = Buffer.from('AVB1')
const CHUNK = 1024 * 1024
const HEADER = 16

export function keyFingerprint(key: Buffer): string {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16)
}

/** "64 hex characters" → key bytes, or null. */
export function parseBackupKey(hex: string): Buffer | null {
  const clean = hex.trim().replace(/\s+/g, '')
  return /^[0-9a-fA-F]{64}$/.test(clean) ? Buffer.from(clean, 'hex') : null
}

function aad(n: number, last: boolean) {
  const b = Buffer.alloc(9)
  b.writeBigUInt64BE(BigInt(n)); b[8] = last ? 1 : 0
  return b
}
function nonce(prefix: Buffer, n: number) {
  const b = Buffer.alloc(12)
  prefix.copy(b, 0); b.writeBigUInt64BE(BigInt(n), 4)
  return b
}

export class EncryptStream extends Transform {
  private buf: Buffer[] = []
  private size = 0
  private n = 0
  private readonly prefix = crypto.randomBytes(4)
  constructor(private readonly key: Buffer) {
    super()
    this.push(Buffer.concat([MAGIC, this.prefix, Buffer.from(keyFingerprint(key), 'hex')]))
  }
  private seal(plain: Buffer, last: boolean) {
    const c = crypto.createCipheriv('aes-256-gcm', this.key, nonce(this.prefix, this.n))
    c.setAAD(aad(this.n, last))
    const body = Buffer.concat([c.update(plain), c.final()])
    const head = Buffer.alloc(5)
    head.writeUInt32BE(plain.length); head[4] = last ? 1 : 0
    this.push(Buffer.concat([head, body, c.getAuthTag()]))
    this.n++
  }
  _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
    this.buf.push(chunk); this.size += chunk.length
    while (this.size > CHUNK) {
      const all = Buffer.concat(this.buf)
      this.seal(all.subarray(0, CHUNK), false)
      const rest = all.subarray(CHUNK)
      this.buf = [rest]; this.size = rest.length
    }
    cb()
  }
  _flush(cb: TransformCallback) {
    this.seal(Buffer.concat(this.buf), true)
    cb()
  }
}

export class DecryptStream extends Transform {
  private buf: Buffer = Buffer.alloc(0)
  private prefix: Buffer | null = null
  private n = 0
  private ended = false
  constructor(private readonly key: Buffer) { super() }
  _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    try { this.drain(); cb() } catch (err) { cb(err as Error) }
  }
  private drain() {
    if (!this.prefix) {
      if (this.buf.length < HEADER) return
      if (!this.buf.subarray(0, 4).equals(MAGIC)) throw new Error('Not a deployer backup file')
      if (this.buf.subarray(8, 16).toString('hex') !== keyFingerprint(this.key)) throw new Error('This backup was made with a different backup key')
      this.prefix = Buffer.from(this.buf.subarray(4, 8))
      this.buf = this.buf.subarray(HEADER)
    }
    while (this.buf.length >= 5) {
      if (this.ended) throw new Error('Unexpected data after the end of the backup file')
      const len = this.buf.readUInt32BE(0)
      const last = this.buf[4] === 1
      if (len > CHUNK) throw new Error('Damaged backup file')
      const need = 5 + len + 16
      if (this.buf.length < need) return
      const d = crypto.createDecipheriv('aes-256-gcm', this.key, nonce(this.prefix, this.n))
      d.setAAD(aad(this.n, last))
      d.setAuthTag(this.buf.subarray(5 + len, need))
      let plain: Buffer
      try { plain = Buffer.concat([d.update(this.buf.subarray(5, 5 + len)), d.final()]) } catch { throw new Error('Damaged backup file (a check failed)') }
      this.push(plain)
      this.buf = this.buf.subarray(need)
      this.n++
      if (last) this.ended = true
    }
  }
  _flush(cb: TransformCallback) {
    if (!this.ended || this.buf.length) return cb(new Error('The backup file is cut short'))
    cb()
  }
}

export async function encryptBuffer(key: Buffer, plain: Buffer): Promise<Buffer> {
  const parts: Buffer[] = []
  const e = new EncryptStream(key)
  const done = new Promise<void>((resolve, reject) => { e.on('end', resolve); e.on('error', reject) })
  e.on('data', (c: Buffer) => parts.push(c))
  e.end(plain)
  await done
  return Buffer.concat(parts)
}

export async function decryptBuffer(key: Buffer, data: Buffer): Promise<Buffer> {
  const parts: Buffer[] = []
  const d = new DecryptStream(key)
  const done = new Promise<void>((resolve, reject) => { d.on('end', resolve); d.on('error', reject) })
  d.on('data', (c: Buffer) => parts.push(c))
  d.end(data)
  await done
  return Buffer.concat(parts)
}
