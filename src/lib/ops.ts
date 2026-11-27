import { db, now } from './db'
import { decryptJson, encryptJson, randomToken } from './crypto'
import { clubDomains } from './clubEnv'
import { deleteClubRow, getClub, getServer, isApp, isPostgres, listClubs, recordClubVersion, updateClub, type Club, type ClubStatus } from './clubs'
import { loadDump } from './postgres/dumps'
import { appsUsing, projectOf, serviceText } from './services'
import type { ServerRow } from './engine'
import { appSettingsText, registryText } from './apps/config'
import { imageDisplay } from './apps/imageRef'
import { runner } from './engine'
import { getSettings } from './settings'
import { backupFinished } from './backups/alerts'
import { getBackup, type BackupKind } from './backups/records'
import { backupsReady, expireRemovedSite, runBackup, runRestore } from './backups/run'

// Every change to a site is an "operation": queued here, run one at a time by
// an in-process worker, with clubctl's output kept as its log.

export type OpKind = 'create' | 'configure' | 'upgrade' | 'pause' | 'resume' | 'remove' | 'backup' | 'restore' | 'site-build' | 'deploy' | 'https' | 'project' | 'rotate'
export type OpStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

export type Operation = {
  id: number
  clubId: number | null
  clubName: string
  kind: OpKind
  status: OpStatus
  batch: string
  log: string
  createdBy: string
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

type OpRow = {
  id: number; club_id: number | null; club_name: string; kind: string; status: string; batch: string
  payload_enc: string; log: string; created_by: string; created_at: string; started_at: string | null; finished_at: string | null
}
type Payload = {
  adminEmail?: string; adminPassword?: string; adminName?: string; image?: string
  /** Apps: the commit message of the image being started. */
  note?: string
  /** backup: which kind (default "Back up now"). restore: which backup, and whether the site is a new copy. */
  backupKind?: BackupKind; backupId?: number; copy?: boolean
  /** restore of a database: a dump uploaded through the deployer (instead of a backup). */
  uploadPath?: string
  /** Anything a plugin's service kind needs for its own steps (Avrosphere: the first admin, a website brief). */
  [key: string]: unknown
}

const toOp = (r: OpRow): Operation => ({
  id: r.id, clubId: r.club_id, clubName: r.club_name, kind: r.kind as OpKind, status: r.status as OpStatus, batch: r.batch,
  log: r.log, createdBy: r.created_by, createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at,
})

export const OP_LABELS: Record<OpKind, string> = {
  create: 'Create', configure: 'Apply settings', upgrade: 'Upgrade', pause: 'Pause', resume: 'Resume', remove: 'Remove', backup: 'Back up', restore: 'Restore', 'site-build': 'Build site', deploy: 'Deploy', https: 'Retry HTTPS',
  project: 'Join project network', rotate: 'New database password',
}

export function enqueue(club: Club, kind: OpKind, createdBy: string, payload: Payload = {}, batch = ''): Operation {
  const info = db().prepare(
    'INSERT INTO operations (club_id, club_name, kind, status, batch, payload_enc, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(club.id, club.name, kind, 'queued', batch, Object.keys(payload).length ? encryptJson(payload) : '', createdBy, now())
  const op = getOperation(Number(info.lastInsertRowid))!
  kick()
  return op
}

export function getOperation(id: number): Operation | null {
  const r = db().prepare('SELECT * FROM operations WHERE id = ?').get(id) as OpRow | undefined
  return r ? toOp(r) : null
}
export function listOperations(opts: { clubId?: number; limit?: number } = {}): Operation[] {
  const limit = Math.min(opts.limit ?? 30, 200)
  const rows = opts.clubId
    ? db().prepare('SELECT * FROM operations WHERE club_id = ? ORDER BY id DESC LIMIT ?').all(opts.clubId, limit)
    : db().prepare('SELECT * FROM operations ORDER BY id DESC LIMIT ?').all(limit)
  return (rows as OpRow[]).map(toOp)
}
/** A club can't take a second change while one is queued or running. */
export function hasPendingOperation(clubId: number): boolean {
  return !!db().prepare("SELECT 1 FROM operations WHERE club_id = ? AND status IN ('queued', 'running') LIMIT 1").get(clubId)
}
export const newBatch = () => randomToken(9)

// ── Worker ───────────────────────────────────────────────────────────────────
const g = globalThis as unknown as { __opsBusy?: boolean; __opsIdle?: Promise<void> }

/** Starts the worker if it isn't already going. */
export function kick() {
  if (g.__opsBusy) return
  g.__opsBusy = true
  g.__opsIdle = drain().finally(() => { g.__opsBusy = false })
}
/** Tests: resolves once the queue is empty. */
export async function whenIdle() {
  while (g.__opsBusy) await g.__opsIdle
}

/** After a restart nothing is really running any more. */
export function recoverInterrupted() {
  const rows = db().prepare("SELECT id, club_id, kind FROM operations WHERE status = 'running'").all() as { id: number; club_id: number | null; kind: string }[]
  for (const r of rows) {
    db().prepare("UPDATE operations SET status = 'failed', finished_at = ?, log = log || ? WHERE id = ?")
      .run(now(), '\n!! The deployer restarted while this was running. Check the site and run it again if needed.\n', r.id)
    if (r.club_id && (r.kind === 'create' || r.kind === 'remove')) updateClub(r.club_id, { status: 'failed' })
  }
}

async function drain() {
  for (;;) {
    const row = db().prepare("SELECT * FROM operations WHERE status = 'queued' ORDER BY id LIMIT 1").get() as OpRow | undefined
    if (!row) return
    db().prepare("UPDATE operations SET status = 'running', started_at = ? WHERE id = ?").run(now(), row.id)
    let ok = false
    try {
      ok = await runOne(row)
    } catch (err) {
      appendLog(row.id, `\n!! ${(err as Error).message}\n`)
    }
    db().prepare('UPDATE operations SET status = ?, finished_at = ?, payload_enc = ? WHERE id = ?').run(ok ? 'done' : 'failed', now(), '', row.id)
    if (!ok) {
      afterFailure(row)
      if (row.batch) {
        // A rollout stops at the first site that fails.
        db().prepare("UPDATE operations SET status = 'cancelled', finished_at = ?, log = ? WHERE batch = ? AND status = 'queued'")
          .run(now(), `Not run: ${row.club_name} failed earlier in the same rollout.\n`, row.batch)
      }
    }
  }
}

function appendLog(id: number, chunk: string) {
  db().prepare('UPDATE operations SET log = substr(log || ?, -200000) WHERE id = ?').run(chunk, id)
}

function afterFailure(row: OpRow) {
  if (!row.club_id) return
  if (row.kind === 'create' || row.kind === 'remove') updateClub(row.club_id, { status: 'failed' })
}

async function runOne(row: OpRow): Promise<boolean> {
  const club = row.club_id ? getClub(row.club_id) : null
  if (!club) { appendLog(row.id, 'The site no longer exists.\n'); return false }
  const server = getServer(club.serverId)
  if (!server) { appendLog(row.id, 'The site\'s server no longer exists.\n'); return false }
  const payload = decryptJson<Payload>(row.payload_enc, {})
  const platform = getSettings()
  const run = runner()
  const out = (chunk: string) => appendLog(row.id, chunk)
  const domains = clubDomains(club, platform.baseDomain).join(',')
  if (row.kind === 'project') return projectSet(server, club, out)
  if (isPostgres(club)) return runPgOne(row, club, server, payload, out)
  if (isApp(club)) return runAppOne(row, club, server, payload, domains, out)
  const kind = row.kind as OpKind
  let done: ClubStatus | null = null
  let result

  switch (kind) {
    case 'https':
      return retryHttps(server, club, out)
    case 'pause':
      result = await run(server, ['pause', club.name], undefined, out)
      done = 'paused'
      break
    case 'resume':
      result = await run(server, ['resume', club.name], undefined, out)
      done = 'running'
      break
    case 'backup': {
      if (!backupsReady()) { result = await run(server, ['backup', club.name], undefined, out); break }
      const kind = payload.backupKind ?? 'manual'
      try {
        await runBackup(club, kind, row.created_by, out)
      } catch (err) {
        out(`!! ${(err as Error).message}\n`)
        if (kind !== 'manual') await backupFinished(club, false, (err as Error).message)
        return false
      }
      await backupFinished(club, true)
      return true
    }
    case 'restore': {
      const backup = payload.backupId ? getBackup(payload.backupId) : null
      if (!backup) { out('That backup no longer exists.\n'); return false }
      await runRestore(club, backup, { copy: !!payload.copy, by: row.created_by }, out)
      if (payload.copy && club.status !== 'running') updateClub(club.id, { status: 'running' })
      return true
    }
    case 'remove':
      if (backupsReady() && (club.status === 'running' || club.status === 'paused' || club.status === 'removing')) {
        try { await runBackup(club, 'final', row.created_by, out, 'Final backup before removing the site') }
        catch (err) { out(`!! The final backup to the bucket failed, so the site was NOT removed: ${(err as Error).message}\n`); return false }
      }
      result = await run(server, ['remove', club.name], undefined, out)
      if (result.code === 0) { expireRemovedSite(club.id); deleteClubRow(club.id); return true }
      break
    default: {
      // Create, apply settings, upgrade and a kind's own steps belong to the plugin that adds the kind.
      const { serviceKind } = await import('@/plugins/server')
      const steps = serviceKind(club.kind)
      const handled = steps ? await steps.runOp(kind, { club, server, payload, createdBy: row.created_by, domains, run, out }) : null
      if (handled === null) { out(`${club.name} has no "${OP_LABELS[kind] ?? kind}" step.\n`); return false }
      return handled
    }
  }
  if (!result || result.code !== 0) return false
  if (done) updateClub(club.id, { status: done })
  return true
}

/** The same operations for an app: no database, no backups, its image comes from its build. */
/** clubctl prints "Pinned to <image>@sha256:…" after pulling an image from a registry. */
export function pinnedImage(output: string): string {
  const m = /^Pinned to (\S+@sha256:[a-f0-9]{64})\s*$/m.exec(output)
  return m ? m[1] : ''
}

/** The version note for an image app: the image as asked for. */
function imageNote(ref: string): string {
  return imageDisplay(ref)
}

async function runAppOne(row: OpRow, club: Club, server: ServerRow, payload: Payload, domains: string, out: (chunk: string) => void): Promise<boolean> {
  const run = runner()
  const kind = row.kind as OpKind
  const settings = () => appSettingsText(club) + serviceText(club)
  let done: ClubStatus | null = null
  let result
  switch (kind) {
    case 'create': {
      const image = payload.image || club.image
      if (!image) { out('No build to start yet.\n'); return false }
      result = await run(server, ['app-create', club.name, image, domains || '-'], settings() + registryText(club), out)
      if (result.code === 0) {
        // An image from a registry runs as the exact version pulled (its digest), so roll back finds it again.
        const ran = pinnedImage(result.output) || image
        updateClub(club.id, { image: ran }); recordClubVersion(club.id, ran, row.created_by, payload.note ?? (club.appImageRef ? imageNote(club.appImageRef) : ''))
      }
      done = 'running'
      break
    }
    case 'deploy': {
      const image = payload.image
      if (!image) { out('No image to deploy.\n'); return false }
      // The settings go along so a new database link or pre-deploy command is used by this version.
      result = await run(server, ['app-deploy', club.name, image], settings() + registryText(club), out)
      if (result.code === 0) {
        const old = club.image
        const ran = pinnedImage(result.output) || image
        updateClub(club.id, { image: ran })
        recordClubVersion(club.id, ran, row.created_by, payload.note ?? (versionNote(club.id, ran) || (club.appImageRef ? imageNote(image) : '')))
        if (old === ran) out('(It was already on this version; restarted.)\n')
      }
      break
    }
    case 'configure':
      result = await run(server, ['configure', club.name, domains || '-'], settings(), out)
      break
    case 'https':
      return retryHttps(server, club, out)
    case 'pause':
      result = await run(server, ['pause', club.name], undefined, out)
      done = 'paused'
      break
    case 'resume':
      result = await run(server, ['resume', club.name], undefined, out)
      done = 'running'
      break
    case 'remove':
      result = await run(server, ['remove', club.name], undefined, out)
      if (result.code === 0) { deleteClubRow(club.id); return true }
      break
    default:
      out(`${OP_LABELS[kind] ?? kind} isn't something an app does.\n`)
      return false
  }
  if (!result || result.code !== 0) return false
  if (done) updateClub(club.id, { status: done })
  return true
}

/** A PostgreSQL service: its own container on its project's network, data kept on the server. */
async function runPgOne(row: OpRow, club: Club, server: ServerRow, payload: Payload, out: (chunk: string) => void): Promise<boolean> {
  const run = runner()
  const kind = row.kind as OpKind
  const settings = () => `CLUBCTL_MEMORY_MB=${club.memoryMb}\n` + serviceText(club)
  let done: ClubStatus | null = null
  let result
  switch (kind) {
    case 'create':
      result = await run(server, ['db-create', club.name, club.image], settings(), out)
      if (result.code === 0) recordClubVersion(club.id, club.image, row.created_by)
      done = 'running'
      break
    case 'configure':
      result = await run(server, ['configure', club.name, '-'], settings(), out)
      break
    case 'pause':
      result = await run(server, ['pause', club.name], undefined, out)
      done = 'paused'
      break
    case 'resume':
      result = await run(server, ['resume', club.name], undefined, out)
      done = 'running'
      break
    case 'rotate':
      result = await run(server, ['db-rotate', club.name], undefined, out)
      if (result.code === 0) restartUsers(club, row.created_by, out)
      break
    case 'upgrade': {
      const image = payload.image
      if (!image) { out('No version to move to.\n'); return false }
      if (backupsReady()) {
        try { await runBackup(club, 'upgrade', row.created_by, out, `Before moving to ${image}`) }
        catch (err) { out(`!! The backup to the bucket failed, so the version was NOT changed: ${(err as Error).message}\n`); return false }
      }
      result = await run(server, ['db-upgrade', club.name, image], undefined, out)
      if (result.code === 0) { updateClub(club.id, { image }); recordClubVersion(club.id, image, row.created_by); restartUsers(club, row.created_by, out) }
      break
    }
    case 'backup': {
      if (!backupsReady()) { out('Backups to a bucket are not set up (Backups page), so there is nowhere to put this one.\n'); return false }
      const bk = payload.backupKind ?? 'manual'
      try { await runBackup(club, bk, row.created_by, out) }
      catch (err) {
        out(`!! ${(err as Error).message}\n`)
        if (bk !== 'manual') await backupFinished(club, false, (err as Error).message)
        return false
      }
      await backupFinished(club, true)
      return true
    }
    case 'restore': {
      if (payload.uploadPath) {
        if (backupsReady()) {
          try { await runBackup(club, 'manual', row.created_by, out, 'Before loading an uploaded dump') }
          catch (err) { out(`!! The backup to the bucket failed, so the dump was NOT loaded: ${(err as Error).message}\n`); return false }
        }
        const ok = await loadDump(server, club, payload.uploadPath, out)
        if (ok) restartUsers(club, row.created_by, out)
        return ok
      }
      const backup = payload.backupId ? getBackup(payload.backupId) : null
      if (!backup) { out('That backup no longer exists.\n'); return false }
      await runRestore(club, backup, { copy: !!payload.copy, by: row.created_by }, out)
      if (payload.copy && club.status !== 'running') updateClub(club.id, { status: 'running' })
      if (!payload.copy) restartUsers(club, row.created_by, out)
      return true
    }
    case 'remove':
      if (backupsReady() && (club.status === 'running' || club.status === 'paused' || club.status === 'removing')) {
        try { await runBackup(club, 'final', row.created_by, out, 'Final backup before removing the database') }
        catch (err) { out(`!! The final backup to the bucket failed, so the database was NOT removed: ${(err as Error).message}\n`); return false }
      }
      result = await run(server, ['remove', club.name], undefined, out)
      if (result.code === 0) { expireRemovedSite(club.id); deleteClubRow(club.id); return true }
      break
    default:
      out(`${OP_LABELS[kind] ?? kind} isn't something a database does.\n`)
      return false
  }
  if (!result || result.code !== 0) return false
  if (done) updateClub(club.id, { status: done })
  return true
}

/** Apps using a database pick up its new password or data with a restart (Apply settings). */
function restartUsers(db: Club, by: string, out: (chunk: string) => void) {
  for (const app of appsUsing(db.id)) {
    if (app.status !== 'running' && app.status !== 'paused') continue
    if (hasPendingOperation(app.id)) { out(`!! ${app.name} is busy; press Save on its settings to restart it with the new values.\n`); continue }
    enqueue(app, 'configure', by)
    out(`==> ${app.name} restarts to use the database's new values\n`)
  }
}

/** Puts a service on its project's network on the server (no restart). */
async function projectSet(server: ServerRow, club: Club, out: (chunk: string) => void): Promise<boolean> {
  const project = projectOf(club)
  if (!project) { out('This service has no project.\n'); return false }
  const result = await runner()(server, ['project-set', club.name, project.name], undefined, out)
  if (result.code !== 0 && /unknown command/.test(result.output)) {
    out('This server has an older clubctl. Re-run the "Set up a VM" workflow for it, then press "Connect services" on the Projects page.\n')
    updateClub(club.id, { projectSynced: 2 })
    return false
  }
  if (result.code === 0) updateClub(club.id, { projectSynced: 1 })
  return result.code === 0
}

/** Queues "Join project network" for services the server hasn't put on their project's network yet. */
export function syncProjectNetworks(by = 'system'): number {
  let n = 0
  for (const club of listClubs()) {
    if (club.projectSynced !== 0 || !club.projectId) continue
    if (club.status !== 'running' && club.status !== 'paused') continue
    if (hasPendingOperation(club.id)) continue
    enqueue(club, 'project', by)
    n++
  }
  return n
}

/** Ask the server's Caddy to request missing certificates now instead of after its back-off. */
async function retryHttps(server: ServerRow, club: Club, out: (chunk: string) => void): Promise<boolean> {
  const result = await runner()(server, ['https', club.name], undefined, out)
  if (result.code !== 0 && /unknown command/.test(result.output)) {
    out('This server has an older clubctl. Re-run the "Set up a VM" workflow for it, then try again.\n')
  }
  return result.code === 0
}

/** The commit message saved with an earlier run of this image (for roll back). */
function versionNote(clubId: number, image: string): string {
  const r = db().prepare("SELECT note FROM club_versions WHERE club_id = ? AND image = ? AND note <> '' ORDER BY id DESC LIMIT 1").get(clubId, image) as { note: string } | undefined
  return r?.note ?? ''
}
