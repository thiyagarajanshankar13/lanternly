import zlib from 'node:zlib'
import { db, now } from '../db'
import { randomToken } from '../crypto'

// The deployer's own list of what is in the bucket. The bucket also holds a
// manifest per backup, so it can be read without this list (backup-tool).

/** hourly/6-hourly, daily, "Back up now", before an upgrade, before a restore, before removing the site. */
export type BackupKind = 'frequent' | 'daily' | 'manual' | 'upgrade' | 'restore' | 'final'
export type BackupStatus = 'running' | 'ready' | 'failed'

export const KIND_LABELS: Record<BackupKind, string> = {
  frequent: 'Scheduled (hourly)', daily: 'Scheduled (daily)', manual: 'Back up now', upgrade: 'Before an upgrade', restore: 'Before a restore', final: 'Before removing the site',
}

export type Backup = {
  id: number
  ref: string
  ns: string
  clubId: number | null
  clubName: string
  kind: BackupKind
  status: BackupStatus
  image: string
  imageDigest: string
  dbBytes: number
  fileCount: number
  fileBytes: number
  newBytes: number
  keepUntil: string | null
  note: string
  error: string
  createdBy: string
  startedAt: string
  finishedAt: string | null
}
/** One uploaded file in a backup: path under data/, content hash, size. */
export type FileEntry = [path: string, sha: string, size: number]

type Row = {
  id: number; ref: string; ns: string; club_id: number | null; club_name: string; kind: string; status: string; image: string; image_digest: string
  db_bytes: number; file_count: number; file_bytes: number; new_bytes: number; keep_until: string | null; note: string; error: string
  created_by: string; started_at: string; finished_at: string | null
}
const COLS = 'id, ref, ns, club_id, club_name, kind, status, image, image_digest, db_bytes, file_count, file_bytes, new_bytes, keep_until, note, error, created_by, started_at, finished_at'
const toBackup = (r: Row): Backup => ({
  id: r.id, ref: r.ref, ns: r.ns, clubId: r.club_id, clubName: r.club_name, kind: r.kind as BackupKind, status: r.status as BackupStatus,
  image: r.image, imageDigest: r.image_digest, dbBytes: r.db_bytes, fileCount: r.file_count, fileBytes: r.file_bytes, newBytes: r.new_bytes,
  keepUntil: r.keep_until, note: r.note, error: r.error, createdBy: r.created_by, startedAt: r.started_at, finishedAt: r.finished_at,
})

/** A site's folder in the bucket: its name plus its id, so a later site with the same name never mixes with it. */
export const clubNs = (club: { id: number; name: string }) => `${club.name}-${club.id}`
export const backupPrefix = (b: { ns: string; ref: string }) => `sites/${b.ns}/${b.ref}/`
export const blobKey = (ns: string, sha: string) => `blobs/${ns}/${sha.slice(0, 2)}/${sha}`
export const imageKey = (digest: string) => `images/${digest.replace(/^sha256:/, '')}.tar.gz`

export function newBackupRef(at = new Date()): string {
  const stamp = at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  return `${stamp}-${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`
}

export function insertBackup(b: { ns: string; clubId: number; clubName: string; kind: BackupKind; createdBy: string; note?: string }): Backup {
  const info = db().prepare('INSERT INTO backups (ref, ns, club_id, club_name, kind, status, note, created_by, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(newBackupRef(), b.ns, b.clubId, b.clubName, b.kind, 'running', b.note ?? '', b.createdBy, now())
  return getBackup(Number(info.lastInsertRowid))!
}

export function updateBackup(id: number, patch: Partial<Pick<Backup, 'status' | 'image' | 'imageDigest' | 'dbBytes' | 'fileCount' | 'fileBytes' | 'newBytes' | 'keepUntil' | 'error' | 'finishedAt'>> & { files?: FileEntry[] }) {
  const map: Record<string, unknown> = {}
  if (patch.status !== undefined) map.status = patch.status
  if (patch.image !== undefined) map.image = patch.image
  if (patch.imageDigest !== undefined) map.image_digest = patch.imageDigest
  if (patch.dbBytes !== undefined) map.db_bytes = patch.dbBytes
  if (patch.fileCount !== undefined) map.file_count = patch.fileCount
  if (patch.fileBytes !== undefined) map.file_bytes = patch.fileBytes
  if (patch.newBytes !== undefined) map.new_bytes = patch.newBytes
  if (patch.keepUntil !== undefined) map.keep_until = patch.keepUntil
  if (patch.error !== undefined) map.error = patch.error.slice(0, 2000)
  if (patch.finishedAt !== undefined) map.finished_at = patch.finishedAt
  if (patch.files !== undefined) map.files_gz = zlib.gzipSync(JSON.stringify(patch.files))
  const cols = Object.keys(map)
  if (!cols.length) return
  db().prepare(`UPDATE backups SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => map[c]), id)
}

export function getBackup(id: number): Backup | null {
  const r = db().prepare(`SELECT ${COLS} FROM backups WHERE id = ?`).get(id) as Row | undefined
  return r ? toBackup(r) : null
}
export function backupFiles(id: number): FileEntry[] {
  const r = db().prepare('SELECT files_gz FROM backups WHERE id = ?').get(id) as { files_gz: Buffer | null } | undefined
  if (!r?.files_gz) return []
  return JSON.parse(zlib.gunzipSync(r.files_gz).toString('utf8')) as FileEntry[]
}
export function listBackups(opts: { clubId?: number; ns?: string; status?: BackupStatus; limit?: number } = {}): Backup[] {
  const where: string[] = []; const args: unknown[] = []
  if (opts.clubId !== undefined) { where.push('club_id = ?'); args.push(opts.clubId) }
  if (opts.ns !== undefined) { where.push('ns = ?'); args.push(opts.ns) }
  if (opts.status !== undefined) { where.push('status = ?'); args.push(opts.status) }
  const sql = `SELECT ${COLS} FROM backups ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC, id DESC LIMIT ?`
  return (db().prepare(sql).all(...args, Math.min(opts.limit ?? 500, 5000)) as Row[]).map(toBackup)
}
export function deleteBackupRow(id: number) {
  db().prepare('DELETE FROM backups WHERE id = ?').run(id)
}

// ── Files and images already in the bucket ───────────────────────────────────
export function knownBlobs(ns: string): Set<string> {
  return new Set((db().prepare('SELECT sha FROM backup_blobs WHERE ns = ?').all(ns) as { sha: string }[]).map((r) => r.sha))
}
export function addBlob(ns: string, sha: string, size: number, stored: number) {
  db().prepare('INSERT OR IGNORE INTO backup_blobs (ns, sha, size, stored, created_at) VALUES (?, ?, ?, ?, ?)').run(ns, sha, size, stored, now())
}
export function listBlobs(ns?: string): { ns: string; sha: string; size: number; stored: number; createdAt: string }[] {
  const rows = ns ? db().prepare('SELECT * FROM backup_blobs WHERE ns = ?').all(ns) : db().prepare('SELECT * FROM backup_blobs').all()
  return (rows as { ns: string; sha: string; size: number; stored: number; created_at: string }[]).map((r) => ({ ns: r.ns, sha: r.sha, size: r.size, stored: r.stored, createdAt: r.created_at }))
}
export function deleteBlobRows(ns: string, shas: string[]) {
  const stmt = db().prepare('DELETE FROM backup_blobs WHERE ns = ? AND sha = ?')
  db().transaction(() => { for (const s of shas) stmt.run(ns, s) })()
}
export function hasImage(digest: string): boolean {
  return !!db().prepare('SELECT 1 FROM backup_images WHERE digest = ?').get(digest)
}
export function addImage(digest: string, image: string, stored: number) {
  db().prepare('INSERT OR REPLACE INTO backup_images (digest, image, stored, created_at) VALUES (?, ?, ?, ?)').run(digest, image, stored, now())
}
export function listImages(): { digest: string; image: string; stored: number; createdAt: string }[] {
  return (db().prepare('SELECT * FROM backup_images ORDER BY created_at DESC').all() as { digest: string; image: string; stored: number; created_at: string }[])
    .map((r) => ({ digest: r.digest, image: r.image, stored: r.stored, createdAt: r.created_at }))
}
export function deleteImageRow(digest: string) {
  db().prepare('DELETE FROM backup_images WHERE digest = ?').run(digest)
}

/** Space used in the bucket, from the deployer's own records (bytes as stored, encrypted). */
export function bucketUsage(): { total: number; byNs: Map<string, number> } {
  const byNs = new Map<string, number>()
  for (const r of db().prepare('SELECT ns, SUM(stored) AS n FROM backup_blobs GROUP BY ns').all() as { ns: string; n: number }[]) byNs.set(r.ns, r.n)
  for (const r of db().prepare("SELECT ns, SUM(db_bytes) AS n FROM backups WHERE status = 'ready' GROUP BY ns").all() as { ns: string; n: number }[]) byNs.set(r.ns, (byNs.get(r.ns) ?? 0) + r.n)
  const images = (db().prepare('SELECT COALESCE(SUM(stored), 0) AS n FROM backup_images').get() as { n: number }).n
  let total = images
  for (const v of byNs.values()) total += v
  return { total, byNs }
}
