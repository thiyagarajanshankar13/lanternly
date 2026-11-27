import type { Backup, BackupKind } from './records'

// When backups are due and when they go. Pure functions (tested).

export type Schedule = {
  backupFrequentHours: number
  backupFrequentKeepDays: number
  backupDaily: boolean
  backupDailyHour: number
  backupDailyKeepDays: number
  timezone: string
}

export const FREQUENT_CHOICES = [0, 1, 6] as const
export const KEEP_CHOICES = [1, 2, 3, 7, 14, 30, 60, 90, 180, 365] as const
const HOUR = 3_600_000
const DAY = 24 * HOUR

/** The calendar date and hour at `at` in a time zone (falls back to Sydney). */
export function localParts(at: Date, timezone: string): { date: string; hour: number } {
  let fmt: Intl.DateTimeFormat
  try { fmt = new Intl.DateTimeFormat('en-CA', { timeZone: timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }) }
  catch { fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }) }
  const p = Object.fromEntries(fmt.formatToParts(at).map((x) => [x.type, x.value]))
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 }
}

/** The scheduled backup due now, if any. `last` = start times of the newest scheduled backups (any status but failed). */
export function dueKind(s: Schedule, last: { frequent?: string; daily?: string }, at = new Date()): 'daily' | 'frequent' | null {
  if (s.backupDaily) {
    const here = localParts(at, s.timezone)
    const lastDay = last.daily ? localParts(new Date(last.daily), s.timezone).date : ''
    const recent = last.daily ? at.getTime() - new Date(last.daily).getTime() < 20 * HOUR : false
    if (here.hour >= s.backupDailyHour && lastDay !== here.date && !recent) return 'daily'
  }
  if (s.backupFrequentHours > 0) {
    const every = s.backupFrequentHours * HOUR
    const slot = Math.floor(at.getTime() / every)
    const newest = [last.frequent, last.daily].filter(Boolean).map((t) => new Date(t!).getTime())
    if (!newest.some((t) => Math.floor(t / every) === slot)) return 'frequent'
  }
  return null
}

export function keepDaysFor(s: Pick<Schedule, 'backupFrequentKeepDays' | 'backupDailyKeepDays'>, kind: BackupKind): number {
  return kind === 'frequent' ? s.backupFrequentKeepDays : s.backupDailyKeepDays
}
export function keepUntilFor(s: Pick<Schedule, 'backupFrequentKeepDays' | 'backupDailyKeepDays'>, kind: BackupKind, startedAt: string): string {
  return new Date(new Date(startedAt).getTime() + keepDaysFor(s, kind) * DAY).toISOString()
}

/**
 * Backups to delete now: past their keep date (except each live site's newest
 * good backup, which is never deleted), failed ones after 2 days, and ones
 * stuck "running" for a day.
 */
export function toFlush(backups: Backup[], liveClubIds: Set<number>, at = new Date()): Backup[] {
  const newestReady = new Map<number, Backup>()
  for (const b of backups) {
    if (b.status !== 'ready' || b.clubId === null || !liveClubIds.has(b.clubId)) continue
    const cur = newestReady.get(b.clubId)
    if (!cur || b.startedAt > cur.startedAt) newestReady.set(b.clubId, b)
  }
  const keep = new Set([...newestReady.values()].map((b) => b.id))
  const t = at.getTime()
  return backups.filter((b) => {
    if (keep.has(b.id)) return false
    if (b.status === 'ready') return !!b.keepUntil && new Date(b.keepUntil).getTime() < t
    if (b.status === 'failed') return t - new Date(b.startedAt).getTime() > 2 * DAY
    return t - new Date(b.startedAt).getTime() > DAY
  })
}

/** How old the newest good backup may get before it counts as overdue, or null with no schedule. */
export function overdueAfterMs(s: Schedule): number | null {
  const gaps: number[] = []
  if (s.backupFrequentHours > 0) gaps.push(s.backupFrequentHours * HOUR)
  if (s.backupDaily) gaps.push(DAY)
  if (!gaps.length) return null
  return Math.min(...gaps) * 2 + HOUR
}

export function scheduleLabel(s: Schedule): string {
  const parts: string[] = []
  if (s.backupFrequentHours > 0) parts.push(`${s.backupFrequentHours === 1 ? 'hourly' : `every ${s.backupFrequentHours} hours`}, kept ${s.backupFrequentKeepDays} day${s.backupFrequentKeepDays === 1 ? '' : 's'}`)
  if (s.backupDaily) parts.push(`daily at ${hourLabel(s.backupDailyHour)}, kept ${s.backupDailyKeepDays} day${s.backupDailyKeepDays === 1 ? '' : 's'}`)
  return parts.length ? parts.join(' + ') : 'off'
}
export function hourLabel(h: number): string {
  if (h === 0) return '12am'
  if (h === 12) return '12pm'
  return h < 12 ? `${h}am` : `${h - 12}pm`
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024, i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}
