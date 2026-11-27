import { currentAdmin } from '@/lib/auth'
import { canSeeSite, isOwner } from '@/lib/access'
import { getServer, listClubs } from '@/lib/clubs'
import { runner } from '@/lib/engine'

export const dynamic = 'force-dynamic'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const admin = await currentAdmin()
  if (!admin) return Response.json({ ok: false, error: 'Not signed in' }, { status: 401 })
  const server = getServer(Number((await params).id))
  // Everyone else only gets the memory of their own sites on this server, not the server's own numbers.
  const mine = isOwner(admin) ? null : new Set(listClubs().filter((c) => c.serverId === server?.id && canSeeSite(admin, c.id)).map((c) => c.name))
  if (!server || (mine && mine.size === 0)) return Response.json({ ok: false, error: 'No such server' }, { status: 404 })
  try {
    const run = runner()
    const host = await run(server, ['host'])
    if (host.code !== 0) return Response.json({ ok: false, error: host.output.trim().slice(0, 300) || 'The server refused.' })
    const status = await run(server, ['status'])
    const clubs: Record<string, { running: boolean; memory: string }> = {}
    for (const line of status.output.split('\n')) {
      if (!line.startsWith('{')) continue
      try {
        const c = JSON.parse(line) as { name: string; running: boolean; memory: string }
        if (!mine || mine.has(c.name)) clubs[c.name] = { running: c.running, memory: c.memory }
      } catch { /* skip a line that isn't JSON */ }
    }
    if (mine) return Response.json({ ok: true, clubs })
    return Response.json({ ok: true, ...JSON.parse(host.output.trim().split('\n').pop() || '{}'), clubs })
  } catch (err) {
    return Response.json({ ok: false, error: (err as Error).message })
  }
}
