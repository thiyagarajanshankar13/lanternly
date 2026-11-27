import { currentAdmin } from '@/lib/auth'
import { canSeeSite, maskSecrets, secretValues } from '@/lib/access'
import { auditView } from '@/lib/audit'
import { getClub, getServer } from '@/lib/clubs'
import { type Follow, followLogs } from '@/lib/liveLogs'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Live logs as server-sent events: `line` events with one (masked) log line
 * each, then `end` with the exit code when the stream stops (the VM stops it
 * after 30 minutes; the browser can reconnect). Closing the page stops it.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const admin = await currentAdmin()
  if (!admin) return Response.json({ error: 'Not signed in' }, { status: 401 })
  const club = getClub(Number((await params).id))
  const server = club ? getServer(club.serverId) : null
  if (!club || !server || !canSeeSite(admin, club.id)) return Response.json({ error: 'Not found' }, { status: 404 })
  if (club.status !== 'running' && club.status !== 'paused') return Response.json({ error: 'The site is not running.' }, { status: 409 })
  await auditView(admin, 'viewed-logs', club, 'Live')

  const secrets = secretValues(club)
  const enc = new TextEncoder()
  let follow: Follow | null = null
  let closed = false
  let lastLines: string[] = []

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return
        try { controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)) } catch { closed = true }
      }
      const close = () => { if (!closed) { closed = true; try { controller.close() } catch { /* already closed */ } } }
      // Batch lines so a chatty app doesn't send thousands of tiny events.
      let batch: string[] = []
      const timer = setInterval(() => {
        if (batch.length) { send('lines', batch); batch = [] }
        else send('ping', Date.now())
      }, 400)
      req.signal.addEventListener('abort', () => { follow?.stop(); clearInterval(timer); close() })
      try {
        follow = await followLogs(server, club.name, 200, (line) => {
          const masked = maskSecrets(line, secrets)
          batch.push(masked)
          lastLines = [...lastLines.slice(-4), masked]
          if (batch.length >= 500) { send('lines', batch); batch = [] }
        })
        if (req.signal.aborted) follow.stop()
        const { code } = await follow.done
        clearInterval(timer)
        if (batch.length) send('lines', batch)
        // An older clubctl doesn't know logs-follow: say what to do about it.
        const old = lastLines.some((l) => l.includes('unknown command: logs-follow'))
        send('end', { code, reason: old ? 'old-server' : code === 124 ? 'timeout' : '' })
      } catch (err) {
        clearInterval(timer)
        send('end', { code: 1, error: (err as Error).message })
      }
      close()
    },
    cancel() { closed = true; follow?.stop() },
  })
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' },
  })
}
