import { connectTo, isFakeEngine, type ServerRow } from './engine'

// Live logs: `clubctl logs-follow NAME LINES` over SSH, handed on line by
// line. The caller masks secrets and sends the lines to the browser; stop()
// closes the SSH channel, which ends `docker logs --follow` on the VM.

export type Follow = { stop: () => void; done: Promise<{ code: number }> }

const g = globalThis as unknown as { __liveLogs?: number }
/** Open streams across the whole deployer, so a stuck browser can't pile up SSH sessions. */
export const MAX_LIVE = 12
export const liveCount = () => g.__liveLogs ?? 0

/** Starts following; `onLine` gets each whole line (no newline). */
export async function followLogs(server: ServerRow, name: string, tail: number, onLine: (line: string) => void): Promise<Follow> {
  if (!/^[a-z0-9-]{1,40}$/.test(name)) throw new Error('bad site name')
  if (liveCount() >= MAX_LIVE) throw new Error('Too many live logs are open right now. Close one and try again.')
  g.__liveLogs = liveCount() + 1
  let released = false
  const release = () => { if (!released) { released = true; g.__liveLogs = Math.max(0, liveCount() - 1) } }

  let partial = ''
  const take = (chunk: string) => {
    const parts = (partial + chunk).split('\n')
    partial = parts.pop() ?? ''
    for (const p of parts) onLine(p.replace(/\r$/, ''))
    // A line with no end for a long time: send what there is.
    if (partial.length > 8000) { onLine(partial); partial = '' }
  }
  const flush = () => { if (partial) onLine(partial); partial = '' }

  if (isFakeEngine()) return fakeFollow(name, tail, take, flush, release)

  try {
    const conn = await connectTo(server)
    return await new Promise<Follow>((resolve, reject) => {
      conn.exec(['logs-follow', name, String(tail)].join(' '), (err, channel) => {
        if (err) { conn.end(); release(); return reject(err) }
        const done = new Promise<{ code: number }>((res) => {
          channel.on('close', (code: number | null) => { flush(); conn.end(); release(); res({ code: code ?? 0 }) })
        })
        channel.on('data', (d: Buffer) => take(d.toString('utf8')))
        channel.stderr.on('data', (d: Buffer) => take(d.toString('utf8')))
        conn.on('error', () => { try { channel.close() } catch { /* already closed */ } })
        channel.end()
        resolve({ stop: () => { try { channel.close() } catch { /* already closed */ } conn.end() }, done })
      })
    })
  } catch (err) {
    release()
    throw err
  }
}

/** Practice mode: a few made-up lines, then one every couple of seconds. */
function fakeFollow(name: string, tail: number, take: (s: string) => void, flush: () => void, release: () => void): Follow {
  const start = [
    `(simulated) ▲ Next.js 15 for ${name}`,
    '   - Local: http://localhost:3000',
    ' ✓ Ready in 2.1s',
  ].slice(-Math.max(1, tail))
  take(start.join('\n') + '\n')
  let n = 0
  let finish: (v: { code: number }) => void = () => {}
  const done = new Promise<{ code: number }>((res) => { finish = res })
  const paths = ['/', '/api/health', '/bookings', '/api/users/me', '/store']
  const timer = setInterval(() => {
    n++
    take(`${new Date().toISOString()} GET ${paths[n % paths.length]} 200 in ${20 + ((n * 37) % 180)}ms\n`)
  }, 2000)
  return {
    stop: () => { clearInterval(timer); flush(); release(); finish({ code: 0 }) },
    done,
  }
}
