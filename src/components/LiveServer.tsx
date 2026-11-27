'use client'

import { useEffect, useState } from 'react'

type Live = { ok: boolean; error?: string; memTotal?: number; memAvailable?: number; diskTotal?: number; diskAvailable?: number; running?: number; clubs?: Record<string, { running: boolean; memory: string }> }

const gb = (n?: number) => (n ? (n / 2 ** 30).toFixed(1) : '?')

/** Memory and disk on a clubs VM, asked for after the page loads so a slow server never blocks it. */
export function LiveServer({ serverId }: { serverId: number }) {
  const [live, setLive] = useState<Live | null>(null)
  useEffect(() => {
    let stop = false
    const load = () => fetch(`/api/admin/servers/${serverId}/live`, { cache: 'no-store' })
      .then((r) => r.json()).then((d) => { if (!stop) setLive(d) }).catch(() => { if (!stop) setLive({ ok: false, error: "Couldn't ask the server." }) })
    load()
    const timer = setInterval(load, 30000)
    return () => { stop = true; clearInterval(timer) }
  }, [serverId])

  if (!live) return <p className="muted small">Checking the server…</p>
  if (!live.ok) return <p className="notice bad" style={{ marginBottom: 0 }}>{live.error}</p>
  const used = (live.memTotal ?? 0) - (live.memAvailable ?? 0)
  const pct = live.memTotal ? Math.round((used / live.memTotal) * 100) : 0
  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="small">Memory: {gb(used)} of {gb(live.memTotal)} GB used</span>
        <span className="small muted">{live.running} running · {gb(live.diskAvailable)} GB disk free</span>
      </div>
      <div className={`bar ${pct >= 85 ? 'high' : ''}`} role="img" aria-label={`${pct}% of memory used`}><span style={{ width: `${pct}%` }} /></div>
    </div>
  )
}

/** One club's live memory, from the same endpoint. */
export function LiveClubMemory({ serverId, name }: { serverId: number; name: string }) {
  const [text, setText] = useState('…')
  useEffect(() => {
    let stop = false
    fetch(`/api/admin/servers/${serverId}/live`, { cache: 'no-store' }).then((r) => r.json()).then((d: Live) => {
      if (stop) return
      const c = d.clubs?.[name]
      setText(!d.ok ? 'unknown' : !c ? 'not on the server' : c.running ? c.memory || 'running' : 'stopped')
    }).catch(() => { if (!stop) setText('unknown') })
    return () => { stop = true }
  }, [serverId, name])
  return <>{text}</>
}
