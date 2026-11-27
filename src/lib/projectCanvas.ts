// The project page draws its services as a diagram: one row per lane
// (on the web, inside the project, databases), lines from an app to the
// databases it uses. Pure and browser-safe (no Node imports): the server
// builds the nodes, the ProjectCanvas client component lays them out.

export type CanvasKind = 'site' | 'app' | 'image' | 'db'
export type CanvasTone = 'ok' | 'warn' | 'bad' | 'info' | ''

export type CanvasNode = {
  id: number
  name: string
  displayName: string
  kind: CanvasKind
  kindLabel: string
  statusLabel: string
  tone: CanvasTone
  /** Public web address (no scheme), null when it has none. */
  url: string | null
  /** host:port inside the project network. */
  inside: string
  /** Repo @ branch, image, PostgreSQL version or Avrosphere release. */
  source: string
  sourceLabel: string
  memoryMb: number
  /** Database ids this service uses. */
  uses: number[]
  db: { used: string; quota: string; pct: number | null; readOnly: boolean } | null
  waitingNetwork: boolean
  updated: string
  href: string
}

export const LANES = ['On the web', 'Inside the project', 'Databases'] as const

export function laneOf(n: Pick<CanvasNode, 'kind' | 'url'>): 0 | 1 | 2 {
  if (n.kind === 'db') return 2
  return n.url ? 0 : 1
}

export const NODE_W = 216
export const NODE_H = 96
const GAP_X = 40
const ROW_H = 140
const TOP = 44
const SIDE = 40

export type CanvasLayout = {
  width: number
  height: number
  pos: Record<number, { x: number; y: number }>
  /** Lane labels for the lanes that have services, with their y. */
  lanes: { label: string; y: number }[]
  edges: { from: number; to: number }[]
}

/** Places nodes in centred rows, skipping empty lanes. */
export function layoutCanvas(nodes: CanvasNode[], minWidth = 640): CanvasLayout {
  const rows: CanvasNode[][] = [[], [], []]
  for (const n of nodes) rows[laneOf(n)].push(n)
  const widest = Math.max(1, ...rows.map((r) => r.length))
  const width = Math.max(minWidth, SIDE * 2 + widest * NODE_W + (widest - 1) * GAP_X)
  const pos: CanvasLayout['pos'] = {}
  const lanes: CanvasLayout['lanes'] = []
  let row = 0
  rows.forEach((r, i) => {
    if (!r.length) return
    const y = TOP + row * ROW_H
    lanes.push({ label: LANES[i], y: y - 24 })
    const total = r.length * NODE_W + (r.length - 1) * GAP_X
    let x = (width - total) / 2
    for (const n of r) { pos[n.id] = { x, y }; x += NODE_W + GAP_X }
    row++
  })
  const ids = new Set(nodes.map((n) => n.id))
  const edges = nodes.flatMap((n) => n.uses.filter((to) => ids.has(to) && to !== n.id).map((to) => ({ from: n.id, to })))
  return { width, height: TOP + Math.max(1, row) * ROW_H - (ROW_H - NODE_H) + 28, pos, lanes, edges }
}

/** SVG path for a line between two placed nodes: side to side on one row, bottom to top otherwise. */
export function edgePath(a: { x: number; y: number }, b: { x: number; y: number }): { d: string; end: [number, number] } {
  if (a.y === b.y) {
    const left = a.x < b.x
    const x1 = left ? a.x + NODE_W : a.x
    const x2 = left ? b.x : b.x + NODE_W
    const y = a.y + NODE_H / 2
    return { d: `M${x1} ${y} L${x2} ${y}`, end: [x2, y] }
  }
  const down = a.y < b.y
  const x1 = a.x + NODE_W / 2
  const y1 = down ? a.y + NODE_H : a.y
  const x2 = b.x + NODE_W / 2
  const y2 = down ? b.y : b.y + NODE_H
  const my = (y1 + y2) / 2
  return { d: `M${x1} ${y1} C${x1} ${my} ${x2} ${my} ${x2} ${y2}`, end: [x2, y2] }
}

/** Overall health for the summary and the projects list. */
export function projectHealth(tones: CanvasTone[]): { label: string; tone: CanvasTone } {
  const bad = tones.filter((t) => t === 'bad').length
  const starting = tones.filter((t) => t === 'info').length
  const stopped = tones.filter((t) => t === 'warn').length
  if (!tones.length) return { label: 'No services', tone: '' }
  if (bad) return { label: `${bad} failed`, tone: 'bad' }
  if (stopped) return { label: `${stopped} stopped`, tone: 'warn' }
  if (starting) return { label: `${starting} being created`, tone: 'info' }
  return { label: 'All running', tone: 'ok' }
}
