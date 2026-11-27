'use client'

import { useEffect, useMemo, useRef, useState } from 'react'

const KEEP = 5000

/** A site's run log: the latest lines on demand, or live as they come, with search, pause and download. */
export function ClubLogs({ clubId, name }: { clubId: number; name?: string }) {
  const [lines, setLines] = useState<string[] | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [count, setCount] = useState(200)
  const [live, setLive] = useState(false)
  const [paused, setPaused] = useState(false)
  const [q, setQ] = useState('')
  const box = useRef<HTMLPreElement>(null)
  const stick = useRef(true)
  const source = useRef<EventSource | null>(null)
  const pausedRef = useRef(false)
  const held = useRef<string[]>([])
  const [heldCount, setHeldCount] = useState(0)

  const add = (more: string[]) => {
    if (pausedRef.current) { held.current = [...held.current, ...more].slice(-KEEP); setHeldCount(held.current.length); return }
    setLines((prev) => [...(prev ?? []), ...more].slice(-KEEP))
  }

  const load = async () => {
    setBusy(true)
    try {
      const res = await fetch(`/api/admin/clubs/${clubId}/logs?lines=${count}`, { cache: 'no-store' })
      const data = await res.json()
      setLines(data.log ? String(data.log).split('\n') : [])
      setNote(data.error || (data.log ? '' : 'Nothing logged yet.'))
    } catch {
      setNote("Couldn't fetch the logs.")
    }
    setBusy(false)
  }

  const stopLive = () => { source.current?.close(); source.current = null; setLive(false); setPaused(false); pausedRef.current = false; held.current = []; setHeldCount(0) }
  const startLive = () => {
    stopLive()
    setLines([])
    setNote('Connecting…')
    held.current = []
    const es = new EventSource(`/api/admin/clubs/${clubId}/logs/live`)
    source.current = es
    setLive(true)
    es.addEventListener('lines', (e) => { setNote(''); add(JSON.parse((e as MessageEvent).data)) })
    es.addEventListener('ping', () => setNote((n) => (n === 'Connecting…' ? '' : n)))
    es.addEventListener('end', (e) => {
      const d = JSON.parse((e as MessageEvent).data) as { code: number; reason?: string; error?: string }
      es.close(); source.current = null; setLive(false)
      setNote(d.error ? `Live logs stopped: ${d.error}`
        : d.reason === 'old-server' ? 'Live logs need the newer clubctl on this server: re-run the "Set up a VM" workflow for the sites VM.'
        : d.reason === 'timeout' ? 'Live logs stop after 30 minutes. Press Live to carry on.'
        : 'Live logs stopped.')
    })
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) { source.current = null; setLive(false); setNote('Lost the connection. Press Live to try again.') }
    }
  }
  useEffect(() => () => source.current?.close(), [])

  const togglePause = () => {
    const next = !paused
    setPaused(next)
    pausedRef.current = next
    setHeldCount(0)
    if (!next && held.current.length) { const more = held.current; held.current = []; setLines((prev) => [...(prev ?? []), ...more].slice(-KEEP)) }
  }

  const shown = useMemo(() => {
    if (!lines) return null
    if (!q.trim()) return lines
    const needle = q.toLowerCase()
    return lines.filter((l) => l.toLowerCase().includes(needle))
  }, [lines, q])

  // Follow the bottom unless the reader scrolled up.
  useEffect(() => { if (box.current && stick.current) box.current.scrollTop = box.current.scrollHeight }, [shown])
  const onScroll = () => { const b = box.current; if (b) stick.current = b.scrollHeight - b.scrollTop - b.clientHeight < 40 }

  const download = () => {
    const blob = new Blob([(lines ?? []).join('\n')], { type: 'text/plain' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${name || `site-${clubId}`}-logs-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.txt`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }

  return (
    <div>
      <div className="log-tools">
        {!live && (
          <>
            <select value={count} onChange={(e) => setCount(Number(e.target.value))} aria-label="How many lines" style={{ width: 'auto' }}>
              {[200, 500, 1000, 2000].map((n) => <option key={n} value={n}>Last {n} lines</option>)}
            </select>
            <button type="button" onClick={load} disabled={busy}>{busy ? 'Fetching…' : lines === null ? 'Show the latest logs' : 'Refresh'}</button>
          </>
        )}
        <button type="button" className={live ? 'primary' : undefined} onClick={live ? stopLive : startLive}>
          {live ? <><span className="live-dot" aria-hidden="true" />Live · Stop</> : 'Live'}
        </button>
        {live && <button type="button" onClick={togglePause}>{paused ? `Carry on${heldCount ? ` (${heldCount} new)` : ''}` : 'Pause'}</button>}
        {lines !== null && (
          <>
            <input type="search" placeholder="Filter lines" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter lines" />
            <button type="button" onClick={download} disabled={!lines.length}>Download</button>
          </>
        )}
      </div>
      {note && <p className="muted small" role="status" style={{ margin: '0 0 8px' }}>{note}</p>}
      {shown !== null && (
        <pre className="log" ref={box} onScroll={onScroll} aria-live={live ? 'off' : 'polite'}>
          {shown.length ? shown.join('\n') : q ? 'No lines match.' : live ? 'Waiting for new lines…' : ''}
        </pre>
      )}
      <p className="help" style={{ marginTop: 8 }}>Secret values (Square keys, passwords, secret settings) are blanked out. Reading logs is recorded in the access log.</p>
    </div>
  )
}
