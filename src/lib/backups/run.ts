import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough, Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { now } from '../db'
import { getServer, listClubs, recordClubVersion, updateClub, type Club } from '../clubs'
import { runner, streamRunner, type ServerRow } from '../engine'
import { getSettings, saveSettings } from '../settings'
import { DecryptStream, EncryptStream, decryptBuffer, encryptBuffer, keyFingerprint, parseBackupKey } from './crypt'
import {
  addBlob, addImage, backupFiles, backupPrefix, blobKey, clubNs, deleteBackupRow, deleteBlobRows, deleteImageRow, getBackup, hasImage,
  imageKey, insertBackup, knownBlobs, listBackups, listBlobs, listImages, updateBackup, type Backup, type BackupKind, type FileEntry,
} from './records'
import { keepUntilFor, toFlush } from './schedule'
import { backupStore, type BackupStore } from './store'

// Off-site backups. The deployer pulls each part from the sites VM over SSH
// (clubctl dump / files-index / files-pack), encrypts it and puts it in the
// bucket; a restore streams it back (clubctl restore-stage / restore-apply).
// The sites VM never sees the bucket or its keys.
//
// In the bucket (every object encrypted with the backup key, see crypt.ts):
//   sites/<site>-<id>/<ref>/manifest.json   what the backup holds (version, files, sizes, checksums)
//   sites/<site>-<id>/<ref>/database.dump   pg_dump custom format
//   sites/<site>-<id>/<ref>/settings.json   the site's own secrets + its deployer settings
//   blobs/<site>-<id>/<ab>/<sha256>         each uploaded file, once, by content
//   images/<digest>.tar.gz                  each app version (image) a backup needs (optional)

export type Manifest = {
  format: 'avrosphere-deployer-backup'
  version: 1
  site: string
  ns: string
  ref: string
  kind: BackupKind
  startedAt: string
  finishedAt: string
  image: string
  imageDigest: string
  imageSaved: boolean
  database: { key: string; size: number; sha256: string }
  settings: { key: string }
  files: FileEntry[]
  keyFingerprint: string
}
export type SavedSettings = {
  secrets: Record<string, string>
  deployer: Pick<Club, 'displayName' | 'modules' | 'customDomains' | 'timezone' | 'memoryMb' | 'extraEnv' | 'ownerEmail' | 'ownerName' | 'secrets'>
}

type Out = (chunk: string) => void

// ── The backup key ───────────────────────────────────────────────────────────
/** The backup key, made on first use. */
export function backupKey(): Buffer {
  const s = getSettings()
  const existing = parseBackupKey(s.backupKey)
  if (existing) return existing
  const fresh = crypto.randomBytes(32)
  saveSettings({ backupKey: fresh.toString('hex'), backupKeySaved: false })
  return fresh
}
export function backupsReady(): boolean {
  return !!backupStore()
}

// ── Small stream helpers ─────────────────────────────────────────────────────
/** Counts bytes and hashes them as they pass. */
class Measure extends Transform {
  bytes = 0
  private hash = crypto.createHash('sha256')
  _transform(chunk: Buffer, _e: BufferEncoding, cb: (err?: Error | null, data?: Buffer) => void) {
    this.bytes += chunk.length; this.hash.update(chunk); cb(null, chunk)
  }
  digest() { return this.hash.digest('hex') }
}

/** Reads lines and exact byte counts from a stream (clubctl's frames). */
class ByteReader {
  private buf: Buffer = Buffer.alloc(0)
  private it: AsyncIterator<Buffer>
  constructor(stream: Readable) { this.it = stream[Symbol.asyncIterator]() }
  private async fill(): Promise<boolean> {
    const { value, done } = await this.it.next()
    if (done) return false
    this.buf = this.buf.length ? Buffer.concat([this.buf, value]) : Buffer.from(value)
    return true
  }
  async line(): Promise<string | null> {
    for (;;) {
      const i = this.buf.indexOf(10)
      if (i >= 0) { const l = this.buf.subarray(0, i).toString('utf8'); this.buf = this.buf.subarray(i + 1); return l }
      if (!(await this.fill())) return null
    }
  }
  async *bytes(n: number): AsyncGenerator<Buffer> {
    let left = n
    while (left > 0) {
      if (!this.buf.length && !(await this.fill())) throw new Error('The file stream from the server ended early')
      const take = Math.min(left, this.buf.length)
      yield this.buf.subarray(0, take)
      this.buf = this.buf.subarray(take)
      left -= take
    }
  }
  async rest() { while (await this.fill()) this.buf = Buffer.alloc(0) }
}

async function readText(stream: Readable): Promise<string> {
  const parts: Buffer[] = []
  for await (const c of stream) parts.push(Buffer.from(c))
  return Buffer.concat(parts).toString('utf8')
}

async function putEncrypted(store: BackupStore, key: string, source: Readable | Buffer): Promise<number> {
  const enc = new EncryptStream(backupKey())
  const counted = new Measure()
  const body = new PassThrough()
  const feeding = pipeline(Buffer.isBuffer(source) ? Readable.from([source]) : source, enc, counted, body)
  await Promise.all([store.put(key, body).catch((e) => { body.destroy(e as Error); throw e }), feeding])
  return counted.bytes
}
async function getDecrypted(store: BackupStore, key: string): Promise<Readable> {
  const src = await store.get(key)
  const out = new DecryptStream(backupKey())
  src.on('error', (e) => out.destroy(e))
  return src.pipe(out)
}
async function getJson<T>(store: BackupStore, key: string): Promise<T> {
  const raw = await readBuffer(await store.get(key))
  return JSON.parse((await decryptBuffer(backupKey(), raw)).toString('utf8')) as T
}
async function readBuffer(stream: Readable): Promise<Buffer> {
  const parts: Buffer[] = []
  for await (const c of stream) parts.push(Buffer.from(c))
  return Buffer.concat(parts)
}

function serverOf(club: Club): ServerRow {
  const server = getServer(club.serverId)
  if (!server) throw new Error("The site's server no longer exists.")
  return server
}
function tmpDir() {
  const dir = path.join(os.tmpdir(), 'deployer-backup')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

// ── Backing up ───────────────────────────────────────────────────────────────
/** One backup of a site into the bucket. Throws (after marking it failed) when anything goes wrong. */
export async function runBackup(club: Club, kind: BackupKind, by: string, out: Out, note = ''): Promise<Backup> {
  const store = backupStore()
  if (!store) throw new Error('Backups to a bucket are not set up (Settings > Backups).')
  const key = backupKey()
  const server = serverOf(club)
  const ns = clubNs(club)
  const row = insertBackup({ ns, clubId: club.id, clubName: club.name, kind, createdBy: by, note })
  const prefix = backupPrefix(row)
  const stream = streamRunner()
  const say = (s: string) => out(`==> ${s}\n`)
  try {
    say(`Backing up ${club.name} to the ${store.label} (${row.ref})`)
    const info = JSON.parse((await readText((await stream(server, ['info', club.name])).stdout)).trim().split('\n').pop() || '{}') as { image?: string; digest?: string }
    const image = info.image || club.image
    const digest = info.digest || ''
    updateBackup(row.id, { image, imageDigest: digest })

    say('Copying the database')
    const dump = await stream(server, ['dump', club.name], undefined, out)
    const measure = new Measure()
    const dbKey = `${prefix}database.dump`
    await putEncrypted(store, dbKey, dump.stdout.pipe(measure))
    const dumped = await dump.done
    if (dumped.code !== 0) throw new Error(`The database copy failed: ${dumped.stderr.trim().split('\n').pop() || `exit ${dumped.code}`}`)
    if (measure.bytes === 0) throw new Error('The database copy came back empty')
    const database = { key: dbKey, size: measure.bytes, sha256: measure.digest() }
    say(`Database: ${measure.bytes} bytes`)

    const secretsOut = await runner()(server, ['secrets', club.name])
    if (secretsOut.code !== 0) throw new Error(`Couldn't read the site's keys: ${secretsOut.output.trim()}`)
    const secrets: Record<string, string> = {}
    for (const line of secretsOut.output.split('\n')) {
      const m = /^(PAYLOAD_SECRET|MAIL_ENCRYPTION_KEY)=([A-Za-z0-9]+)$/.exec(line.trim())
      if (m) secrets[m[1]] = m[2]
    }
    const saved: SavedSettings = {
      secrets,
      deployer: {
        displayName: club.displayName, modules: club.modules, customDomains: club.customDomains, timezone: club.timezone, memoryMb: club.memoryMb,
        extraEnv: club.extraEnv, ownerEmail: club.ownerEmail, ownerName: club.ownerName, secrets: club.secrets,
      },
    }
    const settingsKey = `${prefix}settings.json`
    await putEncrypted(store, settingsKey, Buffer.from(JSON.stringify(saved)))

    say('Listing uploaded files')
    const index = await stream(server, ['files-index', club.name], undefined, out)
    const indexText = await readText(index.stdout)
    const indexed = await index.done
    if (indexed.code !== 0) throw new Error(`Couldn't list the uploaded files: ${indexed.stderr.trim().split('\n').pop()}`)
    let files: FileEntry[] = indexText.split('\n').filter(Boolean).map((l) => {
      const [p, size, sha] = l.split('\t')
      return [p, sha, Number(size)] as FileEntry
    }).filter((f) => f[0] && /^[a-f0-9]{64}$/.test(f[1]))

    const known = knownBlobs(ns)
    const wanted = new Map<string, string>() // sha → first path
    for (const [p, sha] of files) if (!known.has(sha) && !wanted.has(sha)) wanted.set(sha, p)
    let newBytes = 0
    if (wanted.size) {
      say(`Sending ${wanted.size} new file${wanted.size === 1 ? '' : 's'} (${files.length - wanted.size} already in the bucket)`)
      const pack = await stream(server, ['files-pack', club.name], [...wanted.values()].join('\n') + '\n', out)
      const reader = new ByteReader(pack.stdout)
      const changed = new Map<string, string>() // path → sha actually read
      const uploads: Promise<void>[] = []
      for (;;) {
        const line = await reader.line()
        if (line === null) throw new Error('The file stream from the server ended early')
        if (line === 'E') break
        const m = /^F (\d+) (.+)$/.exec(line)
        if (!m) throw new Error(`Unexpected data from the server: ${line.slice(0, 60)}`)
        const size = Number(m[1]); const p = m[2]
        const tmp = path.join(tmpDir(), crypto.randomBytes(8).toString('hex'))
        const hash = crypto.createHash('sha256')
        const fd = fs.openSync(tmp, 'w', 0o600)
        try {
          for await (const chunk of reader.bytes(size)) { hash.update(chunk); fs.writeSync(fd, chunk) }
        } finally { fs.closeSync(fd) }
        const sha = hash.digest('hex')
        changed.set(p, sha)
        if (knownBlobs(ns).has(sha)) { fs.rmSync(tmp, { force: true }); continue }
        uploads.push((async () => {
          try {
            const stored = await putEncrypted(store, blobKey(ns, sha), fs.createReadStream(tmp))
            addBlob(ns, sha, size, stored)
            newBytes += stored
          } finally { fs.rmSync(tmp, { force: true }) }
        })())
        if (uploads.length >= 4) await Promise.all(uploads.splice(0))
      }
      await Promise.all(uploads)
      await reader.rest()
      const packed = await pack.done
      if (packed.code !== 0) throw new Error(`Sending files failed: ${packed.stderr.trim().split('\n').pop()}`)
      // A file that changed since it was listed is kept with what was actually read.
      files = files.map(([p, sha, size]) => (changed.has(p) && changed.get(p) !== sha ? [p, changed.get(p)!, size] : [p, sha, size]) as FileEntry)
    }
    const stored = knownBlobs(ns)
    const missing = files.filter((f) => !stored.has(f[1]))
    if (missing.length) {
      say(`${missing.length} file${missing.length === 1 ? '' : 's'} disappeared while backing up and ${missing.length === 1 ? 'is' : 'are'} left out (${missing.slice(0, 3).map((f) => f[0]).join(', ')})`)
      files = files.filter((f) => stored.has(f[1]))
    }
    const fileBytes = files.reduce((n, f) => n + f[2], 0)

    let imageSaved = false
    if (getSettings().backupSaveImages && digest && club.kind !== 'postgres') { // postgres:NN stays on Docker Hub
      if (hasImage(digest)) imageSaved = true
      else {
        try {
          say(`Saving the version ${image} (first backup that needs it)`)
          const saving = await stream(server, ['image-save', image], undefined, out)
          const storedImage = await putEncrypted(store, imageKey(digest), saving.stdout)
          const r = await saving.done
          if (r.code !== 0) throw new Error(r.stderr.trim().split('\n').pop() || `exit ${r.code}`)
          addImage(digest, image, storedImage)
          newBytes += storedImage
          imageSaved = true
        } catch (err) {
          out(`!! Couldn't save the image itself (the backup still works while the registry has it): ${(err as Error).message}\n`)
        }
      }
    }

    const finishedAt = now()
    const manifest: Manifest = {
      format: 'avrosphere-deployer-backup', version: 1, site: club.name, ns, ref: row.ref, kind, startedAt: row.startedAt, finishedAt,
      image, imageDigest: digest, imageSaved, database, settings: { key: settingsKey }, files, keyFingerprint: keyFingerprint(key),
    }
    await store.put(`${prefix}manifest.json`, await encryptBuffer(key, Buffer.from(JSON.stringify(manifest))))
    updateBackup(row.id, {
      status: 'ready', dbBytes: database.size, fileCount: files.length, fileBytes, newBytes: newBytes + database.size, files, finishedAt,
      keepUntil: keepUntilFor(club, kind, row.startedAt),
    })
    say(`Backup ${row.ref} is ready: database ${database.size} bytes, ${files.length} files`)
    return getBackup(row.id)!
  } catch (err) {
    updateBackup(row.id, { status: 'failed', error: (err as Error).message, finishedAt: now() })
    throw err
  }
}

// ── Restoring ────────────────────────────────────────────────────────────────
export async function readManifest(backup: Backup): Promise<Manifest> {
  const store = backupStore()
  if (!store) throw new Error('Backups to a bucket are not set up (Settings > Backups).')
  const m = await getJson<Manifest>(store, `${backupPrefix(backup)}manifest.json`)
  if (m.format !== 'avrosphere-deployer-backup' || m.ref !== backup.ref) throw new Error("This backup's label doesn't match it")
  return m
}

/** Checks a decrypted part against the size and checksum the manifest recorded. */
async function* verified(stream: Readable, size: number, sha: string, what: string): AsyncGenerator<Buffer> {
  const hash = crypto.createHash('sha256')
  let n = 0
  for await (const chunk of stream) { const b = Buffer.from(chunk); n += b.length; hash.update(b); yield b }
  if (n !== size || hash.digest('hex') !== sha) throw new Error(`${what} in the bucket doesn't match its checksum`)
}

/**
 * Puts a backup onto a site: its database, uploaded files, keys and version.
 * The site's own deployer settings (addresses, modules) stay as they are.
 * Unless `copy`, a safety backup of the site as it is now is taken first.
 */
export async function runRestore(target: Club, backup: Backup, opts: { copy?: boolean; by: string }, out: Out) {
  const store = backupStore()
  if (!store) throw new Error('Backups to a bucket are not set up (Settings > Backups).')
  if (backup.status !== 'ready') throw new Error('That backup is not ready.')
  const server = serverOf(target)
  const say = (s: string) => out(`==> ${s}\n`)
  const manifest = await readManifest(backup)
  say(`Restoring ${backup.clubName} backup ${backup.ref} (${manifest.image}) onto ${target.name}`)

  if (!opts.copy) {
    say('Taking a safety backup of the site as it is now')
    await runBackup(target, 'restore', opts.by, out, `Before restoring ${backup.ref}`)
  }

  const stream = streamRunner()
  const index = await stream(server, ['files-index', target.name], undefined, out)
  const have = new Set((await readText(index.stdout)).split('\n').map((l) => l.split('\t')[2]).filter(Boolean))
  await index.done
  const saved = await getJson<SavedSettings>(store, manifest.settings.key)
  const secrets = Object.entries(saved.secrets ?? {}).filter(([k, v]) => /^(PAYLOAD_SECRET|MAIL_ENCRYPTION_KEY)$/.test(k) && /^[A-Za-z0-9]+$/.test(v))
  const fetched = manifest.files.filter((f) => !have.has(f[1])).length
  say(`Sending the database and ${manifest.files.length} files (${fetched} from the bucket, ${manifest.files.length - fetched} already on the server)`)

  async function* frames(): AsyncGenerator<Buffer> {
    yield Buffer.from(`D ${manifest.database.size}\n`)
    yield* verified(await getDecrypted(store!, manifest.database.key), manifest.database.size, manifest.database.sha256, 'The database copy')
    if (secrets.length) {
      const body = Buffer.from(secrets.map(([k, v]) => `${k}=${v}\n`).join(''))
      yield Buffer.from(`S ${body.length}\n`); yield body
    }
    for (const [p, sha, size] of manifest.files) {
      if (have.has(sha)) { yield Buffer.from(`C ${sha} ${p}\n`); continue }
      yield Buffer.from(`F ${size} ${p}\n`)
      yield* verified(await getDecrypted(store!, blobKey(manifest.ns, sha)), size, sha, `The file ${p}`)
    }
    yield Buffer.from('E\n')
  }
  const source = Readable.from(frames())
  let sourceError: Error | null = null
  source.on('error', (e) => { sourceError = e })
  const staging = await stream(server, ['restore-stage', target.name], source, out)
  await readText(staging.stdout)
  const staged = await staging.done
  if (staged.code !== 0 || sourceError) {
    await runner()(server, ['restore-abort', target.name], undefined, out).catch(() => undefined)
    throw new Error(sourceError ? (sourceError as Error).message : 'The server could not stage the backup (see the output above).')
  }

  const applyArgs = ['restore-apply', target.name, manifest.image, ...(opts.copy ? ['copy'] : [])]
  let applied = await runner()(server, applyArgs, undefined, out)
  if (applied.code === 3) {
    if (!manifest.imageSaved || !manifest.imageDigest) {
      await runner()(server, ['restore-abort', target.name], undefined, out).catch(() => undefined)
      throw new Error(`The version this backup needs (${manifest.image}) is no longer in the registry, and it wasn't saved in the bucket.`)
    }
    say('The version is gone from the registry: loading it from the bucket')
    const loading = await stream(server, ['image-load'], await getDecrypted(store, imageKey(manifest.imageDigest)), out)
    await readText(loading.stdout)
    if ((await loading.done).code !== 0) {
      await runner()(server, ['restore-abort', target.name], undefined, out).catch(() => undefined)
      throw new Error("Couldn't load the saved version onto the server")
    }
    applied = await runner()(server, applyArgs, undefined, out)
  }
  if (applied.code !== 0) throw new Error('The restore did not finish; the site was put back as it was (see the output above).')
  updateClub(target.id, { image: manifest.image })
  recordClubVersion(target.id, manifest.image, opts.by)
  say(`Restored. ${target.name} now runs ${manifest.image} with the data from ${backup.startedAt}`)
}

// ── Flushing old backups ─────────────────────────────────────────────────────

/** Deletes expired backups, then files and versions no kept backup needs. Returns what went. */
export async function flushBackups(at = new Date()): Promise<{ backups: number; blobs: number; images: number }> {
  const store = backupStore()
  if (!store) return { backups: 0, blobs: 0, images: 0 }
  const live = new Set(listClubs().map((c) => c.id))
  const all = listBackups({ limit: 5000 })
  let backups = 0, blobs = 0, images = 0
  for (const b of toFlush(all, live, at)) {
    const objects = await store.list(backupPrefix(b))
    await store.delete(objects.map((o) => o.key))
    deleteBackupRow(b.id)
    backups++
  }
  const remaining = listBackups({ limit: 5000 })
  const busy = new Set(remaining.filter((b) => b.status === 'running').map((b) => b.ns))
  const cutoff = new Date(at.getTime() - 6 * 3_600_000).toISOString()
  const byNs = new Map<string, Set<string>>()
  for (const b of remaining) {
    if (b.status !== 'ready') continue
    const set = byNs.get(b.ns) ?? new Set<string>()
    for (const f of backupFiles(b.id)) set.add(f[1])
    byNs.set(b.ns, set)
  }
  const grouped = new Map<string, string[]>()
  for (const blob of listBlobs()) {
    if (busy.has(blob.ns) || blob.createdAt > cutoff) continue
    if (byNs.get(blob.ns)?.has(blob.sha)) continue
    grouped.set(blob.ns, [...(grouped.get(blob.ns) ?? []), blob.sha])
  }
  for (const [ns, shas] of grouped) {
    await store.delete(shas.map((s) => blobKey(ns, s)))
    deleteBlobRows(ns, shas)
    blobs += shas.length
  }
  if (!busy.size) {
    const needed = new Set(remaining.map((b) => b.imageDigest).filter(Boolean))
    for (const img of listImages()) {
      if (needed.has(img.digest) || img.createdAt > cutoff) continue
      await store.delete([imageKey(img.digest)])
      deleteImageRow(img.digest)
      images++
    }
  }
  return { backups, blobs, images }
}

/** A removed site's backups stay for Settings' "removed sites" days, then go. */
export function expireRemovedSite(clubId: number, days = getSettings().backupRemovedKeepDays) {
  const until = new Date(Date.now() + days * 86_400_000).toISOString()
  for (const b of listBackups({ clubId })) updateBackup(b.id, { keepUntil: until })
}

/** After a site's keep periods change, its existing backups follow the new ones. */
export function reapplyKeep(club: Club) {
  for (const b of listBackups({ clubId: club.id, status: 'ready' })) updateBackup(b.id, { keepUntil: keepUntilFor(club, b.kind, b.startedAt) })
}
