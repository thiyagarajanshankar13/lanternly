import { daysLeft, type WatchedSite } from '@/lib/monitor'

/** Up / Down / Retrying / Paused, as one badge. */
export function StatusBadge({ site, checked }: { site: WatchedSite; checked: boolean }) {
  if (!checked) return <span className="badge">{site.paused ? 'Paused' : 'Not running'}</span>
  if (site.status === 'down') return <span className="badge bad">Down</span>
  if (site.fails > 0) return <span className="badge warn">Retrying</span>
  if (site.status === 'up') return <span className="badge ok">Up</span>
  return <span className="badge">Not checked yet</span>
}

export function CertCell({ site }: { site: WatchedSite }) {
  if (!site.url.startsWith('https:')) return <span className="badge warn">No HTTPS</span>
  const days = daysLeft(site.certExpiresAt)
  if (days === null) return <span className="muted">–</span>
  if (days < 0) return <span className="badge bad">Expired</span>
  if (days <= 14) return <span className="badge warn">{days} day{days === 1 ? '' : 's'} left</span>
  return <span>{days} days left</span>
}

/** "3 minutes", "2 hours", "5 days": how long since an ISO time. */
export function ago(iso: string | null, at = Date.now()): string {
  if (!iso) return ''
  const mins = Math.max(0, Math.round((at - new Date(iso).getTime()) / 60_000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  return `${Math.round(hours / 24)} days ago`
}
