import { currentAdmin } from '@/lib/auth'
import { canSeeSite } from '@/lib/access'
import { auditView } from '@/lib/audit'
import { getClub, getServer } from '@/lib/clubs'
import { runner } from '@/lib/engine'
import { maskedLog } from '@/lib/logs'

export const dynamic = 'force-dynamic'

/** The latest lines of a site's run log (`clubctl logs`), with its secrets blanked out. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const admin = await currentAdmin()
  if (!admin) return Response.json({ error: 'Not signed in' }, { status: 401 })
  const club = getClub(Number((await params).id))
  const server = club ? getServer(club.serverId) : null
  if (!club || !server || !canSeeSite(admin, club.id)) return Response.json({ error: 'Not found' }, { status: 404 })
  const asked = Number(new URL(req.url).searchParams.get('lines'))
  const lines = [200, 500, 1000, 2000].includes(asked) ? asked : 200
  await auditView(admin, 'viewed-logs', club)
  try {
    const res = await runner()(server, ['logs', club.name, String(lines)])
    return Response.json({ log: maskedLog(res.output.slice(-200000), club) })
  } catch (err) {
    return Response.json({ error: (err as Error).message })
  }
}
