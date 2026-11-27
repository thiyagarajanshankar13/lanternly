import { currentAdmin } from '@/lib/auth'
import { canSeeSite, isOwner } from '@/lib/access'
import { auditView } from '@/lib/audit'
import { getClub } from '@/lib/clubs'
import { maskedLog } from '@/lib/logs'
import { getOperation } from '@/lib/ops'

export const dynamic = 'force-dynamic'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const admin = await currentAdmin()
  if (!admin) return Response.json({ error: 'Not signed in' }, { status: 401 })
  const op = getOperation(Number((await params).id))
  // A removed site's operations (club_id gone) are for owners only.
  if (!op || !(isOwner(admin) || canSeeSite(admin, op.clubId))) return Response.json({ error: 'Not found' }, { status: 404 })
  const club = op.clubId ? getClub(op.clubId) : null
  if (club) await auditView(admin, 'viewed-output', club, `Operation ${op.id}`)
  return Response.json({ id: op.id, status: op.status, log: maskedLog(op.log, club) })
}
