import { getServer, newNameError, insertClub, listClubs, serverRoomError, updateClub, type Bucket, type Club } from '../clubs'
import { runner } from '../engine'
import { enqueue } from '../ops'
import { alertRecipients } from '../monitor'
import { mailReady, sendMail } from '../mail'
import { getSettings } from '../settings'
import {
  S3_DEFAULT_IMAGE, S3_MAX_BUCKETS, S3_MEMORY_MAX, S3_MEMORY_MIN, S3_QUOTA_MAX, S3_QUOTA_MIN, bucketNameError, quotaLevel, type Project,
} from '../projects'
import { appsUsing } from '../services'

// S3 storage services (MinIO): creating one, its buckets, and the 5-minute
// watch that keeps its numbers and sends the quota alerts. The quota is soft:
// it emails at 80% and 100% but never stops writes.

export const S3_DEFAULT_MEMORY_MB = 256
export const S3_DEFAULT_QUOTA_MB = 10240

export type NewStorage = { name: string; displayName?: string; bucket?: string; publicBucket?: boolean; web?: boolean; memoryMb?: number; quotaMb?: number }

export function storageSettingsError(memoryMb: number, quotaMb: number): string | null {
  if (!(memoryMb >= S3_MEMORY_MIN && memoryMb <= S3_MEMORY_MAX)) return `Memory must be between ${S3_MEMORY_MIN} and ${S3_MEMORY_MAX} MB.`
  if (!(quotaMb >= S3_QUOTA_MIN && quotaMb <= S3_QUOTA_MAX)) return `The quota must be between ${S3_QUOTA_MIN / 1024} GB and ${S3_QUOTA_MAX / 1000 / 1000} TB.`
  return null
}

/** Checks a new storage's fields; null when they are fine. */
export function storageError(s: NewStorage): string | null {
  const nameErr = newNameError(s.name)
  if (nameErr) return `Name: ${nameErr}`
  const bucketErr = bucketNameError(s.bucket || 'files')
  if (bucketErr) return `First bucket: ${bucketErr}`
  return storageSettingsError(s.memoryMb ?? S3_DEFAULT_MEMORY_MB, s.quotaMb ?? S3_DEFAULT_QUOTA_MB)
}

/** Adds a storage to a project and queues its creation. Returns the new service or why not. */
export function createStorage(project: Project, s: NewStorage, by: string, batch = ''): { club: Club } | { error: string } {
  const err = storageError(s)
  if (err) return { error: err }
  const server = getServer(project.serverId)
  if (!server) return { error: "This project's server is gone." }
  const memoryMb = s.memoryMb ?? S3_DEFAULT_MEMORY_MB
  const room = serverRoomError(server, { memoryMb, site: false })
  if (room) return { error: room }
  const club = insertClub({
    name: s.name, displayName: s.displayName || s.name, serverId: server.id, status: 'creating', image: S3_DEFAULT_IMAGE,
    modules: [], customDomains: [], secrets: {}, extraEnv: '', timezone: getSettings().defaultTimezone, memoryMb, ownerEmail: '', ownerName: '',
    notes: '', kind: 'minio', projectId: project.id, createdBy: by, pgQuotaMb: s.quotaMb ?? S3_DEFAULT_QUOTA_MB, appPublic: !!s.web,
    s3Buckets: [{ name: s.bucket || 'files', public: !!s.publicBucket, objects: null, bytes: null }],
  })
  enqueue(club, 'create', by, {}, batch)
  return { club }
}

/** The CLUBCTL_ lines a storage's create and configure carry. */
export function storageLines(club: Club): string {
  return `CLUBCTL_MEMORY_MB=${club.memoryMb}\n` + bucketLines(club.s3Buckets)
}
export const bucketLines = (buckets: Pick<Bucket, 'name' | 'public'>[]) =>
  buckets.map((b) => `CLUBCTL_BUCKET=${b.name}:${b.public ? 'public' : 'private'}\n`).join('')

/** A bucket to add (or a change to one); null when fine. */
export function bucketChangeError(club: Club, name: string, adding: boolean): string | null {
  const err = bucketNameError(name)
  if (err) return err
  const has = club.s3Buckets.some((b) => b.name === name)
  if (adding && has) return `There is already a bucket called ${name}.`
  if (!adding && !has) return `There is no bucket called ${name}.`
  if (adding && club.s3Buckets.length >= S3_MAX_BUCKETS) return `A storage holds up to ${S3_MAX_BUCKETS} buckets. Add another storage for more.`
  return null
}

/** A storage's connection values from the server (secret included), for "Reveal". */
export async function storageCredentials(club: Club): Promise<{ lines: string[] } | { error: string }> {
  const server = getServer(club.serverId)
  if (!server) return { error: "This storage's server is gone." }
  const res = await runner()(server, ['s3-credentials', club.name])
  if (res.code !== 0) return { error: res.output.trim().split('\n').pop() || 'The server could not read them.' }
  return { lines: res.output.split('\n').filter((l) => /^[A-Z0-9_]+=/.test(l)) }
}

type Stats = { running: boolean; bytes: number; buckets: { name: string; objects: number; bytes: number; public: boolean }[] }

type Sender = (subject: string, text: string) => Promise<void> | void
const g = globalThis as unknown as { __s3Sender?: Sender }
export function setStorageAlertSenderForTests(sender: Sender | undefined) { g.__s3Sender = sender }

async function alert(subject: string, text: string) {
  if (g.__s3Sender) return g.__s3Sender(subject, text)
  if (!mailReady()) return
  const error = await sendMail(alertRecipients(), subject, text)
  if (error) console.error(`[storage] alert not sent: ${error}`)
}

const mb = (bytes: number) => `${Math.round(bytes / 1024 / 1024).toLocaleString('en')} MB`

/** One storage: fresh numbers, then the quota emails. */
export async function checkStorage(club: Club): Promise<Stats | null> {
  const server = getServer(club.serverId)
  if (!server || (club.status !== 'running' && club.status !== 'paused')) return null
  const res = await runner()(server, ['s3-stats', club.name])
  if (res.code !== 0) return null
  let stats: Stats
  try { stats = JSON.parse(res.output.trim().split('\n').pop() || '') as Stats } catch { return null }
  const seen = new Map(stats.buckets.map((b) => [b.name, b]))
  updateClub(club.id, {
    pgSizeBytes: stats.bytes, pgCheckedAt: new Date().toISOString(),
    s3Buckets: club.s3Buckets.map((b) => ({ ...b, objects: seen.get(b.name)?.objects ?? b.objects, bytes: seen.get(b.name)?.bytes ?? b.bytes })),
  })

  const level = quotaLevel(stats.bytes, club.pgQuotaMb)
  const quota = `${(club.pgQuotaMb / 1024).toLocaleString('en')} GB`
  const who = `${club.displayName} (${club.name})`
  const users = appsUsing(club.id).map((a) => a.name)
  if (level > club.pgAlertLevel) {
    if (level === 100) {
      await alert(`Storage full: ${club.displayName}`,
        `${who} has used ${mb(stats.bytes)} of its ${quota} quota${users.length ? ` (used by ${users.join(', ')})` : ''}. Apps can still save files, but the server's disk is what really limits it.\n\nRaise its quota on the storage's page in the deployer (Settings), or delete files from it.`)
    } else {
      await alert(`Storage 80% full: ${club.displayName}`, `${who} has used ${mb(stats.bytes)} of its ${quota} quota.\n\nRaise its quota on the storage's page in the deployer (Settings), or delete files from it.`)
    }
    updateClub(club.id, { pgAlertLevel: level })
  } else if (level < club.pgAlertLevel) {
    updateClub(club.id, { pgAlertLevel: level })
  }
  return stats
}

/** One pass over every storage (called by the 5-minute database watch). */
export async function runStorageWatch(): Promise<number> {
  let n = 0
  for (const club of listClubs().filter((c) => c.kind === 'minio')) {
    try { if (await checkStorage(club)) n++ } catch (err) { console.error(`[storage] check of ${club.name} failed:`, (err as Error).message) }
  }
  return n
}
