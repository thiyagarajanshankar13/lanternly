import { db, now } from './db'

// The access log: who signed in, changed access or settings, revealed a key,
// restored a backup or read a site's logs. Operations keep their own "By"
// column; this is for everything else. Kept for a year.

export const AUDIT_LABELS: Record<string, string> = {
  'sign-in': 'Signed in',
  'sign-in-failed': 'Sign-in failed',
  'code-failed': 'Two-step code wrong',
  'sign-out': 'Signed out',
  'invite': 'Invited',
  'invite-renewed': 'New invite link',
  'invite-accepted': 'Accepted invite',
  'access-changed': 'Access changed',
  'suspended': 'Suspended',
  'unsuspended': 'Unsuspended',
  'removed-person': 'Removed',
  'two-step-reset': 'Two-step reset',
  'password-changed': 'Password changed',
  'settings': 'Changed settings',
  'server': 'Changed a server',
  'server-create': 'Created a server',
  'server-delete': 'Deleted a server',
  'github': 'Changed GitHub settings',
  'assistant': 'Changed AI assistant settings',
  'bucket': 'Changed the backup bucket',
  'backup-key-shown': 'Showed the backup key',
  'restore': 'Restored a backup',
  'restore-copy': 'Copied a backup to a new site',
  'costs': 'Changed costs settings',
  'monitoring': 'Changed monitoring',
  'viewed-logs': 'Read logs',
  'project': 'Changed a project',
  'db-credentials-shown': 'Showed database password',
  'db-dump-downloaded': 'Downloaded a database dump',
  'db-dump-loaded': 'Loaded a database dump',
  'viewed-output': 'Read deploy output',
}

export type AuditEntry = {
  id: number; at: string; actorId: number | null; actorEmail: string; action: string
  clubId: number | null; clubName: string; detail: string; ip: string
}
type AuditRow = { id: number; at: string; actor_id: number | null; actor_email: string; action: string; club_id: number | null; club_name: string; detail: string; ip: string }

const KEEP_DAYS = 365
const VIEW_EVERY_MINUTES = 60

type Actor = { id: number; email: string } | null
type Site = { id: number; name: string } | null | undefined

async function ipNow(): Promise<string> {
  try {
    const { headers } = await import('next/headers')
    const h = await headers()
    return (h.get('x-forwarded-for') || '').split(',')[0].trim()
  } catch {
    return '' // outside a request (tests, background work)
  }
}

export async function audit(actor: Actor, action: string, opts: { club?: Site; detail?: string; email?: string } = {}) {
  const ip = await ipNow()
  db().prepare('INSERT INTO audit_log (at, actor_id, actor_email, action, club_id, club_name, detail, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(now(), actor?.id ?? null, actor?.email ?? opts.email ?? '', action, opts.club?.id ?? null, opts.club?.name ?? '', (opts.detail ?? '').slice(0, 500), ip.slice(0, 64))
  if (Math.random() < 0.02) {
    db().prepare('DELETE FROM audit_log WHERE at < ?').run(new Date(Date.now() - KEEP_DAYS * 86400000).toISOString())
  }
}

/** Log reads, at most one line per person per site per hour. */
export async function auditView(actor: { id: number; email: string }, action: 'viewed-logs' | 'viewed-output', club: { id: number; name: string }, detail = '') {
  const since = new Date(Date.now() - VIEW_EVERY_MINUTES * 60000).toISOString()
  const seen = db().prepare('SELECT 1 FROM audit_log WHERE actor_id = ? AND action = ? AND club_id = ? AND at > ? LIMIT 1').get(actor.id, action, club.id, since)
  if (!seen) await audit(actor, action, { club, detail })
}

export function listAudit(opts: { limit?: number; actorId?: number } = {}): AuditEntry[] {
  const limit = Math.min(opts.limit ?? 200, 1000)
  const rows = (opts.actorId
    ? db().prepare('SELECT * FROM audit_log WHERE actor_id = ? ORDER BY id DESC LIMIT ?').all(opts.actorId, limit)
    : db().prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit)) as AuditRow[]
  return rows.map((r) => ({
    id: r.id, at: r.at, actorId: r.actor_id, actorEmail: r.actor_email, action: r.action,
    clubId: r.club_id, clubName: r.club_name, detail: r.detail, ip: r.ip,
  }))
}
