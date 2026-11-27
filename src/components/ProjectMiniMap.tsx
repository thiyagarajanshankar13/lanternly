import { NODE_H, NODE_W, edgePath, layoutCanvas, type CanvasNode } from '@/lib/projectCanvas'

/** A small picture of a project's canvas for the projects list: boxes, lines and status dots, no text. */
export function ProjectMiniMap({ nodes }: { nodes: CanvasNode[] }) {
  if (!nodes.length) return <div className="pl-map pl-map-empty"><span>No services yet</span></div>
  const l = layoutCanvas(nodes, 1000)
  const pad = 24
  const top = Math.min(...Object.values(l.pos).map((p) => p.y))
  const vb = `0 ${top - pad} ${l.width} ${l.height - top + pad - 28 + pad}`
  return (
    <div className="pl-map">
      <svg viewBox={vb} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
        {l.edges.map((e) => {
          const a = l.pos[e.from], b = l.pos[e.to]
          return a && b ? <path key={`${e.from}-${e.to}`} d={edgePath(a, b).d} className="pl-map-link" /> : null
        })}
        {nodes.map((n) => {
          const p = l.pos[n.id]
          return (
            <g key={n.id}>
              <rect x={p.x} y={p.y} width={NODE_W} height={NODE_H} rx={16} className="pl-map-node" />
              <circle cx={p.x + 30} cy={p.y + NODE_H / 2} r={11} className={`pl-map-dot ${n.tone}`} />
              <rect x={p.x + 56} y={p.y + NODE_H / 2 - 7} width={NODE_W - 92} height={14} rx={7} className={`pl-map-bar pl-map-${n.kind}`} />
            </g>
          )
        })}
      </svg>
    </div>
  )
}
