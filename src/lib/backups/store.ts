import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { DeleteObjectsCommand, GetObjectCommand, HeadBucketCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { dataDir } from '../db'
import { isFakeEngine } from '../engine'
import { getSettings } from '../settings'

// Where backups go: the Lightsail bucket (it speaks the S3 protocol), or a
// local folder in practice mode and tests. Only the deployer holds the keys.

export type StoredObject = { key: string; size: number }

export interface BackupStore {
  readonly label: string
  put(key: string, body: Readable | Buffer): Promise<void>
  get(key: string): Promise<Readable>
  list(prefix: string): Promise<StoredObject[]>
  delete(keys: string[]): Promise<void>
  /** Throws with a readable reason when the bucket can't be used. */
  check(): Promise<void>
}

export class S3Store implements BackupStore {
  readonly label: string
  private client: S3Client
  constructor(private readonly bucket: string, region: string, accessKeyId: string, secretAccessKey: string, endpoint?: string) {
    this.label = `bucket ${bucket} (${region})`
    this.client = new S3Client({
      region, credentials: { accessKeyId, secretAccessKey },
      ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
    })
  }
  async put(key: string, body: Readable | Buffer) {
    await new Upload({ client: this.client, params: { Bucket: this.bucket, Key: key, Body: body, ContentType: 'application/octet-stream' }, partSize: 16 * 1024 * 1024, queueSize: 2 }).done()
  }
  async get(key: string): Promise<Readable> {
    const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))
    if (!out.Body) throw new Error(`Empty object in the bucket: ${key}`)
    return out.Body as Readable
  }
  async list(prefix: string): Promise<StoredObject[]> {
    const out: StoredObject[] = []
    let token: string | undefined
    do {
      const page = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }))
      for (const o of page.Contents ?? []) if (o.Key) out.push({ key: o.Key, size: o.Size ?? 0 })
      token = page.IsTruncated ? page.NextContinuationToken : undefined
    } while (token)
    return out
  }
  async delete(keys: string[]) {
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000)
      if (!batch.length) continue
      const out = await this.client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true } }))
      if (out.Errors?.length) throw new Error(`The bucket refused to delete ${out.Errors.length} file(s): ${out.Errors[0].Message ?? out.Errors[0].Code}`)
    }
  }
  async check() {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }))
    const key = `deployer-check/${Date.now()}`
    await this.put(key, Buffer.from('ok'))
    const back = await this.get(key)
    for await (const _ of back) { /* read it back */ }
    await this.delete([key])
  }
}

/** A folder that behaves like the bucket (practice mode, tests). */
export class LocalStore implements BackupStore {
  readonly label: string
  constructor(private readonly root: string) { this.label = `folder ${root}` }
  private file(key: string) {
    if (key.split('/').some((p) => p === '..' || p === '')) throw new Error(`bad key: ${key}`)
    return path.join(this.root, key)
  }
  async put(key: string, body: Readable | Buffer) {
    const f = this.file(key)
    fs.mkdirSync(path.dirname(f), { recursive: true })
    const tmp = `${f}.part`
    if (Buffer.isBuffer(body)) fs.writeFileSync(tmp, body)
    else await pipeline(body, fs.createWriteStream(tmp))
    fs.renameSync(tmp, f)
  }
  async get(key: string): Promise<Readable> {
    const f = this.file(key)
    if (!fs.existsSync(f)) throw new Error(`Not in the bucket: ${key}`)
    return fs.createReadStream(f)
  }
  async list(prefix: string): Promise<StoredObject[]> {
    const out: StoredObject[] = []
    const walk = (dir: string) => {
      if (!fs.existsSync(dir)) return
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) walk(full)
        else if (!e.name.endsWith('.part')) {
          const key = path.relative(this.root, full).split(path.sep).join('/')
          if (key.startsWith(prefix)) out.push({ key, size: fs.statSync(full).size })
        }
      }
    }
    walk(this.root)
    return out.sort((a, b) => a.key.localeCompare(b.key))
  }
  async delete(keys: string[]) {
    for (const k of keys) {
      const f = this.file(k)
      fs.rmSync(f, { force: true })
      // Empty folders go too, like in a bucket (where folders don't exist).
      for (let d = path.dirname(f); d.startsWith(this.root) && d !== this.root; d = path.dirname(d)) {
        try { fs.rmdirSync(d) } catch { break }
      }
    }
  }
  async check() { fs.mkdirSync(this.root, { recursive: true }) }
}

const g = globalThis as unknown as { __backupStoreForTests?: BackupStore }
export function setBackupStoreForTests(store: BackupStore | undefined) { g.__backupStoreForTests = store }

/** The configured store, or null when backups to a bucket aren't set up. */
export function backupStore(): BackupStore | null {
  if (g.__backupStoreForTests) return g.__backupStoreForTests
  const s = getSettings()
  if (s.backupBucket && s.backupAccessKeyId && s.backupSecretAccessKey) {
    return new S3Store(s.backupBucket, s.backupRegion || 'ap-southeast-2', s.backupAccessKeyId, s.backupSecretAccessKey, s.backupEndpoint || undefined)
  }
  if (isFakeEngine() && s.backupBucket) return new LocalStore(path.join(dataDir(), 'practice-bucket', s.backupBucket.replace(/[^a-z0-9.-]/g, '')))
  return null
}
