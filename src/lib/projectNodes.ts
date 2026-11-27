import { type Club } from './clubs'
import { clubDomains } from './clubEnv'
import { pgVersionOf } from './projects'
import { kindLabel, appsUsing } from './services'
import { imageDisplay } from './apps/imageRef'
import { fmtTime } from '@/components/ui'
import type { CanvasNode, CanvasTone } from './projectCanvas'

// Server side of the project canvas: turns services into the plain nodes
// the diagram (and the mini maps on the projects list) draw.

const fmtMb = (bytes: number | null) => (bytes === null ? '–' : bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${Math.round(bytes / 1024 / 1024).toLocaleString('en')} MB`)

export const TONE: Record<Club['status'], [string, CanvasTone]> = { creating: ['Being created', 'info'], running: ['Running', 'ok'], paused: ['Paused', 'warn'], failed: ['Failed', 'bad'], removing: ['Being removed', 'warn'] }

export function toNode(c: Club, baseDomain: string, all: Club[], shown: Set<number>, operate: boolean): CanvasNode {
  // Any kind a plugin adds is drawn as a site.
  const kind = c.kind === 'postgres' ? 'db' : c.kind !== 'app' ? 'site' : c.appImageRef ? 'image' : 'app'
  const url = c.kind === 'postgres' ? null : clubDomains(c, baseDomain)[0] ?? null
  const port = c.kind === 'app' ? c.appPort : c.kind === 'postgres' ? 5432 : 3000
  const uses = c.kind === 'app' ? all.filter((d) => d.kind === 'postgres' && shown.has(d.id) && appsUsing(d.id).some((a) => a.id === c.id)).map((d) => d.id) : []
  const tag = /:([^:/@]+)$/.exec(c.image)?.[1]
  const [statusLabel, tone] = TONE[c.status] ?? [c.status, '']
  return {
    id: c.id, name: c.name, displayName: c.displayName, kind,
    kindLabel: kind === 'image' ? 'Docker image' : kind === 'app' ? 'App from GitHub' : kindLabel(c.kind),
    statusLabel, tone, url, inside: `${c.name}:${port}`,
    source: kind === 'image' ? imageDisplay(c.appImageRef) : kind === 'app' ? `${c.appRepo} @ ${c.appBranch}` : kind === 'db' ? `PostgreSQL ${pgVersionOf(c.image)}` : tag ? `${kindLabel(c.kind).replace(/ site$/, '')} ${tag}` : '',
    sourceLabel: kind === 'image' ? 'Image' : kind === 'app' ? 'Code' : kind === 'db' ? 'Version' : 'Release',
    memoryMb: c.memoryMb, uses,
    db: c.kind === 'postgres' ? {
      used: fmtMb(c.pgSizeBytes), quota: `${(c.pgQuotaMb / 1024).toLocaleString('en')} GB`, readOnly: c.pgReadOnly,
      pct: c.pgSizeBytes === null ? null : Math.min(100, Math.round((c.pgSizeBytes / (c.pgQuotaMb * 1024 * 1024)) * 100)),
    } : null,
    waitingNetwork: operate && c.projectSynced === 2,
    updated: fmtTime(c.updatedAt),
    href: `/admin/clubs/${c.id}`,
  }
}

