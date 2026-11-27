import { getClubByName, getServer, newNameError, insertClub, listClubs, serverRoomError, updateClub, type Club } from '../clubs'
import { runner } from '../engine'
import { hasPendingOperation, enqueue, syncProjectNetworks } from '../ops'
import { alertRecipients } from '../monitor'
import { mailReady, sendMail } from '../mail'
import { getSettings } from '../settings'
import { clubNameError } from '../validate'
import {
  PG_DEFAULT_VERSION, PG_MEMORY_MAX, PG_MEMORY_MIN, PG_QUOTA_MAX, PG_QUOTA_MIN, PG_VERSIONS, pgImage, quotaLevel, type Project,
} from '../projects'
import { appsUsing } from '../services'
import { runStorageWatch } from '../storage/service'

// PostgreSQL services: creating one, and the 5-minute watch that keeps its
// numbers, sends the quota alerts and stops writes at 100% of the quota.

export const PG_DEFAULT_MEMORY_MB = 256
export const PG_DEFAULT_QUOTA_MB = 5120

export type NewDatabase = { name: string; displayName?: string; version?: string; memoryMb?: number; quotaMb?: number }

/** Checks a new database's fields; null when they are fine. */
export function databaseError(d: NewDatabase): string | null {
  const nameErr = newNameError(d.name)
  if (nameErr) return `Name: ${nameErr}`
  if (d.version && !(PG_VERSIONS as readonly string[]).includes(d.version)) return `Pick PostgreSQL ${PG_VERSIONS.join(' or ')}.`
  return settingsError(d.memoryMb ?? PG_DEFAULT_MEMORY_MB, d.quotaMb ?? PG_DEFAULT_QUOTA_MB)
}

export function settingsError(memoryMb: number, quotaMb: number): string | null {
  if (!(memoryMb >= PG_MEMORY_MIN && memoryMb <= PG_MEMORY_MAX)) return `Memory must be between ${PG_MEMORY_MIN} and ${PG_MEMORY_MAX} MB.`
  if (!(quotaMb >= PG_QUOTA_MIN && quotaMb <= PG_QUOTA_MAX)) return `The disk quota must be between ${PG_QUOTA_MIN} MB and ${PG_QUOTA_MAX / 1000} GB.`
  return null
}

/** Adds a database to a project and queues its creation. Returns the new service or why not. */
export function createDatabase(project: Project, d: NewDatabase, by: string, batch = ''): { club: Club } | { error: string } {
  const err = databaseError(d)
  if (err) return { error: err }
  const server = getServer(project.serverId)
  if (!server) return { error: "This project's server is gone." }
  const memoryMb = d.memoryMb ?? PG_DEFAULT_MEMORY_MB
  const room = serverRoomError(server, { memoryMb, site: false })
  if (room) return { error: room }
  const club = insertClub({
    name: d.name, displayName: d.displayName || d.name, serverId: server.id, status: 'creating', image: pgImage(d.version || PG_DEFAULT_VERSION),
    modules: [], customDomains: [], secrets: {}, extraEnv: '', timezone: getSettings().defaultTimezone, memoryMb, ownerEmail: '', ownerName: '',
    notes: '', kind: 'postgres', projectId: project.id, createdBy: by, pgQuotaMb: d.quotaMb ?? PG_DEFAULT_QUOTA_MB,
  })
  enqueue(club, 'create', by, {}, batch)
  return { club }
}

/** A database's connection values from the server (password included), for "Reveal". */
export async function databaseCredentials(club: Club): Promise<{ lines: string[] } | { error: string }> {
  const server = getServer(club.serverId)
  if (!server) return { error: "This database's server is gone." }
  const res = await runner()(server, ['db-credentials', club.name])
  if (res.code !== 0) return { error: res.output.trim().split('\n').pop() || 'The server could not read them.' }
  return { lines: res.output.split('\n').filter((l) => /^[A-Z_]+=/.test(l)) }
}

type Stats = { running: boolean; bytes: number; connections: number; maxConnections: number; readOnly: boolean }

type Sender = (subject: string, text: string) => Promise<void> | void
const g = globalThis as unknown as { __pgTimer?: NodeJS.Timeout; __pgBusy?: boolean; __pgSender?: Sender }
export function setDatabaseAlertSenderForTests(sender: Sender | undefined) { g.__pgSender = sender }

async function alert(subject: string, text: string) {
  if (g.__pgSender) return g.__pgSender(subject, text)
  if (!mailReady()) return
  const error = await sendMail(alertRecipients(), subject, text)
  if (error) console.error(`[postgres] alert not sent: ${error}`)
}

const mb = (bytes: number) => `${Math.round(bytes / 1024 / 1024).toLocaleString('en')} MB`

/** One database: fresh numbers, then the quota rules. */
export async function checkDatabase(club: Club): Promise<Stats | null> {
  const server = getServer(club.serverId)
  if (!server || (club.status !== 'running' && club.status !== 'paused')) return null
  const run = runner()
  const res = await run(server, ['db-stats', club.name])
  if (res.code !== 0) return null
  let stats: Stats
  try { stats = JSON.parse(res.output.trim().split('\n').pop() || '') as Stats } catch { return null }
  updateClub(club.id, {
    pgSizeBytes: stats.running ? stats.bytes : club.pgSizeBytes, pgConnections: stats.running ? stats.connections : null,
    pgMaxConnections: stats.running ? stats.maxConnections : club.pgMaxConnections, pgCheckedAt: new Date().toISOString(), pgReadOnly: stats.readOnly,
  })
  if (!stats.running) return stats

  const level = quotaLevel(stats.bytes, club.pgQuotaMb)
  const quota = `${club.pgQuotaMb.toLocaleString('en')} MB`
  const who = `${club.displayName} (${club.name})`
  const users = appsUsing(club.id).map((a) => a.name)
  const busy = hasPendingOperation(club.id)

  // Writes stop at 100% and start again once it is back under (quota raised or data deleted).
  if (level === 100 && !stats.readOnly && !busy) {
    const r = await run(server, ['db-readonly', club.name, 'on'])
    if (r.code === 0) { updateClub(club.id, { pgReadOnly: true }); stats.readOnly = true }
  } else if (level < 100 && stats.readOnly && !busy) {
    const r = await run(server, ['db-readonly', club.name, 'off'])
    if (r.code === 0) { updateClub(club.id, { pgReadOnly: false }); stats.readOnly = false }
  }

  if (level > club.pgAlertLevel) {
    if (level === 100) {
      await alert(`Database full: ${club.displayName}`,
        `${who} has used ${mb(stats.bytes)} of its ${quota} quota, so it now only reads: apps can't save anything new in it${users.length ? ` (${users.join(', ')})` : ''}.\n\nRaise its quota on the database's page in the deployer (Settings), or delete data from it. Writes start again within 5 minutes.`)
    } else {
      await alert(`Database 80% full: ${club.displayName}`,
        `${who} has used ${mb(stats.bytes)} of its ${quota} quota. At 100% it stops taking writes.\n\nRaise its quota on the database's page in the deployer (Settings), or delete data from it.`)
    }
    updateClub(club.id, { pgAlertLevel: level })
  } else if (level < club.pgAlertLevel) {
    if (club.pgAlertLevel === 100) await alert(`Database taking writes again: ${club.displayName}`, `${who} is under its ${quota} quota again (${mb(stats.bytes)} used) and takes writes again.`)
    updateClub(club.id, { pgAlertLevel: level })
  }
  return stats
}

/** One pass over every database and storage, plus moving services onto their project networks. */
export async function runDatabaseWatch(): Promise<number> {
  if (g.__pgBusy) return 0
  g.__pgBusy = true
  try {
    let n = 0
    for (const club of listClubs().filter((c) => c.kind === 'postgres')) {
      try { if (await checkDatabase(club)) n++ } catch (err) { console.error(`[postgres] check of ${club.name} failed:`, (err as Error).message) }
    }
    n += await runStorageWatch()
    syncProjectNetworks()
    return n
  } finally {
    g.__pgBusy = false
  }
}

/** Every 5 minutes (once per process). DEPLOYER_DB_WATCH=off stops it. */
export function startDatabaseWatch() {
  if (g.__pgTimer || /^(0|false|no|off)$/i.test(process.env.DEPLOYER_DB_WATCH || '')) return
  g.__pgTimer = setInterval(() => { void runDatabaseWatch() }, 5 * 60_000)
  g.__pgTimer.unref?.()
  setTimeout(() => { void runDatabaseWatch() }, 30_000).unref?.()
}
