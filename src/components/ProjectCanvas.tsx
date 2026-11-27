'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { Icon } from '@/components/Icon'
import { LANES, NODE_H, NODE_W, edgePath, laneOf, layoutCanvas, type CanvasKind, type CanvasNode } from '@/lib/projectCanvas'

const KIND_ICON: Record<CanvasKind, 'globe' | 'rocket' | 'box' | 'db'> = { site: 'globe', app: 'rocket', image: 'box', db: 'db' }

function Status({ node }: { node: CanvasNode }) {
  return <span className={`pc-status ${node.tone}`}><i />{node.statusLabel}</span>
}

/** The project's services as a diagram, with the chosen service's details beside it. */
export function ProjectCanvas({ nodes }: { nodes: CanvasNode[] }) {
  // Lane order (web, internal, databases), so the first one shown is picked first.
  const ordered = [...nodes].sort((a, b) => laneOf(a) - laneOf(b))
  const [sel, setSel] = useState<number>(ordered[0]?.id ?? 0)
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const layout = layoutCanvas(nodes)

  // #service-<name> picks a service, so a link can open the page on it.
  useEffect(() => {
    const pick = () => {
      const m = /^#service-(.+)$/.exec(window.location.hash)
      const hit = m && nodes.find((n) => n.name === decodeURIComponent(m[1]))
      if (hit) setSel(hit.id)
    }
    pick()
    window.addEventListener('hashchange', pick)
    return () => window.removeEventListener('hashchange', pick)
  }, [nodes])

  const choose = (n: CanvasNode) => {
    setSel(n.id)
    window.history.replaceState(null, '', `#service-${encodeURIComponent(n.name)}`)
  }

  const s = byId.get(sel) ?? ordered[0]
  if (!s) return null
  const uses = s.uses.map((id) => byId.get(id)).filter((n): n is CanvasNode => !!n)
  const usedBy = nodes.filter((n) => n.uses.includes(s.id))

  return (
    <div className="pc-split">
      <div className="pc-canvas-wrap">
        <div className="pc-canvas" style={{ width: layout.width, height: layout.height }}>
          {layout.lanes.map((l) => <div key={l.label} className="pc-lane" style={{ top: l.y }}>{l.label}</div>)}
          <svg className="pc-links" width={layout.width} height={layout.height} aria-hidden="true">
            {layout.edges.map((e) => {
              const a = layout.pos[e.from], b = layout.pos[e.to]
              if (!a || !b) return null
              const { d, end } = edgePath(a, b)
              const hot = e.from === s.id || e.to === s.id
              return (
                <g key={`${e.from}-${e.to}`} className={hot ? 'hot' : ''}>
                  <path d={d} />
                  <circle cx={end[0]} cy={end[1]} r={3.5} />
                </g>
              )
            })}
          </svg>
          {nodes.map((n) => {
            const p = layout.pos[n.id]
            return (
              <button key={n.id} type="button" className={`pc-node${n.id === s.id ? ' on' : ''}`} style={{ left: p.x, top: p.y, width: NODE_W, height: NODE_H }} onClick={() => choose(n)} aria-pressed={n.id === s.id}>
                <span className="pc-node-top">
                  <span className={`pc-k pc-k-${n.kind}`}><Icon name={KIND_ICON[n.kind]} size={15} /></span>
                  <span className="pc-node-name">
                    <strong>{n.displayName}</strong>
                    <small>{n.url ?? n.inside}</small>
                  </span>
                </span>
                <span className="pc-node-foot">
                  <Status node={n} />
                  <span>{n.db ? `${n.db.used} used` : `${n.memoryMb} MB`}</span>
                </span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="pc-phone">
        {LANES.map((label, lane) => {
          const inLane = ordered.filter((n) => laneOf(n) === lane)
          return inLane.length ? (
            <div key={label}>
              <div className="pc-phone-lane">{label}</div>
              {inLane.map((n) => (
                <button key={n.id} type="button" className={`pc-phone-row${n.id === s.id ? ' on' : ''}`} onClick={() => choose(n)} aria-pressed={n.id === s.id}>
                  <span className={`pc-k pc-k-${n.kind}`}><Icon name={KIND_ICON[n.kind]} size={15} /></span>
                  <span className="pc-node-name"><strong>{n.displayName}</strong><small>{n.url ?? n.inside}{n.uses.length ? ` · uses ${n.uses.map((id) => byId.get(id)?.name).filter(Boolean).join(', ')}` : ''}</small></span>
                  <Status node={n} />
                </button>
              ))}
            </div>
          ) : null
        })}
      </div>

      <aside className="pc-panel" aria-label={`${s.displayName} details`}>
        <div className="pc-panel-head">
          <span className={`pc-k pc-k-${s.kind} big`}><Icon name={KIND_ICON[s.kind]} size={18} /></span>
          <div style={{ minWidth: 0 }}>
            <h2>{s.displayName}</h2>
            <p className="muted small">{s.kindLabel}</p>
          </div>
        </div>
        <dl className="facts">
          <dt>Status</dt><dd><Status node={s} /></dd>
          <dt>Web address</dt>
          <dd>{s.url ? <a href={`https://${s.url}`} target="_blank" rel="noreferrer">{s.url}</a> : <span className="muted">{s.kind === 'db' ? 'None (databases are private)' : 'None (inside the project only)'}</span>}</dd>
          <dt>Inside the project</dt><dd className="mono">{s.inside}</dd>
          {s.source && <><dt>{s.sourceLabel}</dt><dd className={s.kind === 'app' || s.kind === 'image' ? 'mono' : ''}>{s.source}</dd></>}
          {s.db && <>
            <dt>Size</dt>
            <dd>
              {s.db.pct === null ? `Not measured yet (quota ${s.db.quota})` : `${s.db.used} of ${s.db.quota} (${s.db.pct}%)`}
              {s.db.readOnly && <span className="badge bad" style={{ marginLeft: 6 }}>read-only: full</span>}
              {s.db.pct !== null && <div className={`bar${s.db.pct >= 100 ? ' high' : s.db.pct >= 80 ? ' warn' : ''}`} style={{ marginTop: 4 }}><span style={{ width: `${Math.max(2, s.db.pct)}%` }} /></div>}
            </dd>
          </>}
          {s.kind === 'app' || s.kind === 'image' ? <><dt>Uses</dt><dd>{uses.length ? <span className="pc-chips">{uses.map((u) => <button key={u.id} type="button" className="pc-chip" onClick={() => choose(u)}><Icon name="db" size={12} /> {u.name}</button>)}</span> : <span className="muted">No databases</span>}</dd></> : null}
          {s.kind === 'db' && <><dt>Used by</dt><dd>{usedBy.length ? <span className="pc-chips">{usedBy.map((u) => <button key={u.id} type="button" className="pc-chip" onClick={() => choose(u)}><Icon name={KIND_ICON[u.kind]} size={12} /> {u.name}</button>)}</span> : <span className="muted">No apps yet</span>}</dd></>}
          <dt>Memory</dt><dd>{s.memoryMb} MB</dd>
          {s.waitingNetwork && <><dt>Network</dt><dd><span className="badge warn">waiting for a newer clubctl</span></dd></>}
          <dt>Changed</dt><dd className="muted">{s.updated}</dd>
        </dl>
        <div className="row">
          <Link className="btn primary pc-go" href={s.href}>Open service <Icon name="chevron" size={14} /></Link>
          {s.url && <a className="btn" href={`https://${s.url}`} target="_blank" rel="noreferrer"><Icon name="ext" size={14} /> Visit</a>}
        </div>
        <p className="help" style={{ margin: 0 }}>Deploys, logs, settings and backups are on the service page.</p>
      </aside>
    </div>
  )
}
