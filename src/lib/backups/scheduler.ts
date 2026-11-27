import { listClubs, updateClub } from '../clubs'
import { alert } from './alerts'
import { enqueue, hasPendingOperation } from '../ops'
import { flushBackups } from './run'
import { listBackups, type Backup } from './records'
import { dueKind, overdueAfterMs } from './schedule'
import { backupStore } from './store'

// Once a minute: queues each site's scheduled backup when it is due, warns
// when a site's backups fail or fall behind, and once an hour flushes
// backups past their keep date.

const g = globalThis as unknown as { __backupTimer?: NodeJS.Timeout; __backupBusy?: boolean; __backupFlushedAt?: number }

/** The newest scheduled attempts that count: a failure counts for 2 hours, then it is retried. */
export function lastScheduled(backups: Backup[], at = new Date()): { frequent?: string; daily?: string } {
  const counts = (b: Backup) => b.status !== 'failed' || at.getTime() - new Date(b.startedAt).getTime() < 2 * 3_600_000
  return {
    frequent: backups.find((b) => b.kind === 'frequent' && counts(b))?.startedAt,
    daily: backups.find((b) => b.kind === 'daily' && counts(b))?.startedAt,
  }
}

/** One pass. Returns how many backups were queued. */
export async function runBackupSchedule(at = new Date()): Promise<number> {
  if (g.__backupBusy || !backupStore()) return 0
  g.__backupBusy = true
  try {
    let queued = 0
    for (const club of listClubs()) {
      if (club.status !== 'running' || club.kind === 'app') continue
      const backups = listBackups({ clubId: club.id, limit: 200 })
      const kind = dueKind(club, lastScheduled(backups, at), at)
      if (kind && !hasPendingOperation(club.id)) {
        enqueue(club, 'backup', 'schedule', { backupKind: kind })
        queued++
      }
      const limit = overdueAfterMs(club)
      const newest = backups.find((b) => b.status === 'ready')
      const since = newest?.startedAt ?? club.createdAt
      if (limit !== null && at.getTime() - new Date(since).getTime() > limit && !club.backupAlert) {
        updateClub(club.id, { backupAlert: 'overdue' })
        await alert(`Backups overdue: ${club.displayName}`,
          `${club.displayName} (${club.name}) has had no good backup since ${newest ? since.slice(0, 16).replace('T', ' ') + ' UTC' : 'it was created'}.\n\nCheck the site's page in the deployer: its backups may be failing, or other changes to the site may be holding them up.`)
      }
    }
    if (!g.__backupFlushedAt || at.getTime() - g.__backupFlushedAt >= 3_600_000) {
      g.__backupFlushedAt = at.getTime()
      const gone = await flushBackups(at)
      if (gone.backups || gone.blobs || gone.images) console.log(`[backups] flushed ${gone.backups} backups, ${gone.blobs} files, ${gone.images} versions`)
    }
    return queued
  } finally {
    g.__backupBusy = false
  }
}

/** Starts the timer (once per process). DEPLOYER_BACKUPS=off stops it. */
export function startBackupScheduler() {
  if (g.__backupTimer || /^(0|false|no|off)$/i.test(process.env.DEPLOYER_BACKUPS || '')) return
  const tick = () => { runBackupSchedule().catch((err) => console.error('[backups]', (err as Error).message)) }
  g.__backupTimer = setInterval(tick, 60_000)
  g.__backupTimer.unref?.()
  setTimeout(tick, 30_000).unref?.()
}
