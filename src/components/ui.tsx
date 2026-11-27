import type { ClubStatus } from '@/lib/clubs'
import type { OpStatus } from '@/lib/ops'
import { displayLocale, getSettings } from '@/lib/settings'

const CLUB: Record<ClubStatus, [string, string]> = {
  creating: ['Being created', 'info'], running: ['Running', 'ok'], paused: ['Paused', 'warn'], failed: ['Failed', 'bad'], removing: ['Being removed', 'warn'],
}
export function ClubBadge({ status }: { status: ClubStatus }) {
  const [label, tone] = CLUB[status] ?? [status, '']
  return <span className={`badge ${tone}`}>{label}</span>
}

const OP: Record<OpStatus, [string, string]> = {
  queued: ['Waiting', ''], running: ['In progress', 'info'], done: ['Done', 'ok'], failed: ['Failed', 'bad'], cancelled: ['Not run', 'warn'],
}
export function OpBadge({ status }: { status: OpStatus }) {
  const [label, tone] = OP[status] ?? [status, '']
  return <span className={`badge ${tone}`}>{label}</span>
}

/** Same text on the server and in the browser: fixed zone, fixed format (Settings: time zone, locale). Server only. */
export function fmtTime(iso: string | null, timeZone = getSettings().defaultTimezone || 'UTC'): string {
  if (!iso) return ''
  return new Intl.DateTimeFormat(displayLocale(), { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true, timeZone }).format(new Date(iso))
}

export function shortImage(image: string): string {
  const tag = image.includes(':') ? image.slice(image.lastIndexOf(':') + 1) : image
  return tag.length > 14 ? tag.slice(0, 12) + '…' : tag
}
