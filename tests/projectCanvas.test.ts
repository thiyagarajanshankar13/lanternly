import { describe, expect, it } from 'vitest'
import { edgePath, laneOf, layoutCanvas, projectHealth, NODE_H, NODE_W, type CanvasNode } from '@/lib/projectCanvas'

const node = (id: number, kind: CanvasNode['kind'], url: string | null, uses: number[] = []): CanvasNode => ({
  id, name: `s${id}`, displayName: `S${id}`, kind, kindLabel: '', statusLabel: 'Running', tone: 'ok', url, inside: `s${id}:3000`,
  source: '', sourceLabel: '', memoryMb: 256, uses, db: null, waitingNetwork: false, updated: '', href: `/admin/clubs/${id}`,
})

describe('project canvas', () => {
  it('puts web services on top, internal ones in the middle, databases at the bottom', () => {
    expect(laneOf(node(1, 'app', 'a.avro.site'))).toBe(0)
    expect(laneOf(node(2, 'image', null))).toBe(1)
    expect(laneOf(node(3, 'db', null))).toBe(2)
  })

  it('skips empty lanes and draws only links inside the project', () => {
    const l = layoutCanvas([node(1, 'app', 'a.avro.site', [3, 99]), node(3, 'db', null)])
    expect(l.lanes.map((x) => x.label)).toEqual(['On the web', 'Data'])
    expect(l.edges).toEqual([{ from: 1, to: 3 }])
    expect(l.pos[3].y).toBeGreaterThan(l.pos[1].y)
    expect(l.pos[1].x).toBe(l.pos[3].x) // both centred
  })

  it('widens the canvas for a long row and keeps nodes apart', () => {
    const l = layoutCanvas([1, 2, 3, 4, 5].map((i) => node(i, 'app', `${i}.avro.site`)))
    expect(l.width).toBeGreaterThan(5 * NODE_W)
    expect(l.pos[2].x - l.pos[1].x).toBeGreaterThan(NODE_W)
  })

  it('links side to side on one row and bottom to top across rows', () => {
    expect(edgePath({ x: 0, y: 0 }, { x: 300, y: 0 }).end).toEqual([300, NODE_H / 2])
    expect(edgePath({ x: 0, y: 0 }, { x: 0, y: 200 }).end).toEqual([NODE_W / 2, 200])
  })

  it('sums up health', () => {
    expect(projectHealth([]).label).toBe('No services')
    expect(projectHealth(['ok', 'ok']).tone).toBe('ok')
    expect(projectHealth(['ok', 'info']).label).toBe('1 being created')
    expect(projectHealth(['ok', 'warn']).label).toBe('1 stopped')
    expect(projectHealth(['bad', 'warn']).label).toBe('1 failed')
  })
})
