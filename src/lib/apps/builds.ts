import { db, now } from '../db'
import { randomToken } from '../crypto'
import { getClub, isApp, listClubs, updateClub, type Club } from '../clubs'
import { enqueue } from '../ops'
import { appImage, commitTitle } from './config'
import { buildRepo, github } from './github'

// Builds of apps. A build runs on GitHub Actions (build-app-image.yml), not in
// the operation queue, so a slow build never holds up other sites. A timer
// follows each run; when it succeeds the app's create or deploy operation is
// queued with the new image.

export type BuildStatus = 'queued' | 'building' | 'done' | 'failed'
/** What happens once the image exists. */
export type BuildReason = 'create' | 'deploy'

export type AppBuild = {
  id: number
  clubId: number
  sha: string
  message: string
  dockerfile: string
  image: string
  status: BuildStatus
  requestId: string
  runId: number | null
  runUrl: string
  error: string
  reason: BuildReason
  createdBy: string
  createdAt: string
  finishedAt: string | null
}

type Row = {
  id: number; club_id: number; sha: string; message: string; dockerfile: string; image: string; status: string; request_id: string
  run_id: number | null; run_url: string; error: string; reason: string; created_by: string; created_at: string; finished_at: string | null
}
const toBuild = (r: Row): AppBuild => ({
  id: r.id, clubId: r.club_id, sha: r.sha, message: r.message, dockerfile: r.dockerfile, image: r.image, status: r.status as BuildStatus,
  requestId: r.request_id, runId: r.run_id, runUrl: r.run_url, error: r.error, reason: r.reason as BuildReason, createdBy: r.created_by,
  createdAt: r.created_at, finishedAt: r.finished_at,
})

/** No run found this long after asking for one: GitHub didn't start it. */
const FIND_RUN_MS = 5 * 60_000
/** A build still going after this long is given up on. */
const BUILD_MAX_MS = 45 * 60_000

export function getBuild(id: number): AppBuild | null {
  const r = db().prepare('SELECT * FROM app_builds WHERE id = ?').get(id) as Row | undefined
  return r ? toBuild(r) : null
}
export function listBuilds(clubId: number, limit = 10): AppBuild[] {
  return (db().prepare('SELECT * FROM app_builds WHERE club_id = ? ORDER BY id DESC LIMIT ?').all(clubId, limit) as Row[]).map(toBuild)
}
export function activeBuild(clubId: number): AppBuild | null {
  const r = db().prepare("SELECT * FROM app_builds WHERE club_id = ? AND status IN ('queued', 'building') ORDER BY id DESC LIMIT 1").get(clubId) as Row | undefined
  return r ? toBuild(r) : null
}
function patchBuild(id: number, p: Partial<Pick<AppBuild, 'status' | 'runId' | 'runUrl' | 'error'>> & { finished?: boolean }) {
  const map: Record<string, unknown> = {}
  if (p.status !== undefined) map.status = p.status
  if (p.runId !== undefined) map.run_id = p.runId
  if (p.runUrl !== undefined) map.run_url = p.runUrl
  if (p.error !== undefined) map.error = p.error.slice(0, 1000)
  if (p.finished) map.finished_at = now()
  const cols = Object.keys(map)
  if (cols.length) db().prepare(`UPDATE app_builds SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => map[c]), id)
}

/** Once an image exists: create the app, or deploy it. */
function afterImage(club: Club, image: string, message: string, reason: BuildReason, by: string) {
  const note = commitTitle(message)
  if (reason === 'create') {
    if (club.status === 'creating') enqueue(club, 'create', by, { image, note })
    return
  }
  if (club.status === 'running' || club.status === 'paused') enqueue(club, 'deploy', by, { image, note })
}

function failed(build: { id: number; clubId: number; reason: BuildReason }, error: string) {
  patchBuild(build.id, { status: 'failed', error, finished: true })
  if (build.reason === 'create') {
    const club = getClub(build.clubId)
    if (club?.status === 'creating') updateClub(club.id, { status: 'failed' })
  }
}

/**
 * Builds the app's branch (or the given commit) and then creates or deploys
 * it. A commit already built is deployed straight away; one being built is
 * not built twice.
 */
export async function startBuild(club: Club, opts: { by: string; reason: BuildReason; sha?: string; message?: string }): Promise<AppBuild | { reused: string }> {
  if (!isApp(club)) throw new Error(`${club.name} isn't an app.`)
  const gh = github()
  let sha = opts.sha ?? ''
  let message = opts.message ?? ''
  if (!sha) {
    const head = await gh.branchHead(club.appRepo, club.appBranch)
    sha = head.sha
    message = head.message
  }
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('GitHub gave an odd commit id.')
  const image = appImage(buildRepo(), club.name, sha)
  const dockerfile = club.appDockerfile || 'Dockerfile'

  const same = db().prepare("SELECT * FROM app_builds WHERE club_id = ? AND sha = ? AND dockerfile = ? AND status IN ('queued', 'building', 'done') ORDER BY id DESC LIMIT 1")
    .get(club.id, sha, dockerfile) as Row | undefined
  if (same?.status === 'done') {
    afterImage(club, same.image, same.message, opts.reason, opts.by)
    return { reused: same.image }
  }
  if (same) return toBuild(same)

  const requestId = randomToken(9).replace(/[^A-Za-z0-9]/g, 'x')
  const info = db().prepare(
    'INSERT INTO app_builds (club_id, sha, message, dockerfile, image, status, request_id, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(club.id, sha, message.slice(0, 2000), dockerfile, image, 'queued', requestId, opts.reason, opts.by, now())
  const id = Number(info.lastInsertRowid)
  try {
    const run = await gh.dispatchBuild({ app: club.name, repo: club.appRepo, sha, dockerfile, request: requestId })
    if (run) patchBuild(id, { status: 'building', runId: run.id, runUrl: run.url })
  } catch (err) {
    failed({ id, clubId: club.id, reason: opts.reason }, (err as Error).message)
  }
  kickBuildPoller()
  return getBuild(id)!
}

/** One look at every unfinished build. Returns how many finished. */
export async function pollBuilds(at = Date.now()): Promise<number> {
  const rows = (db().prepare("SELECT * FROM app_builds WHERE status IN ('queued', 'building') ORDER BY id").all() as Row[]).map(toBuild)
  const gh = github()
  let finished = 0
  for (const b of rows) {
    const age = at - new Date(b.createdAt).getTime()
    try {
      let run = b.runId ? await gh.getRun(b.runId) : await gh.findRun(b.requestId)
      if (!run) {
        if (age > FIND_RUN_MS) { failed(b, 'GitHub never started the build. Check that the build workflow is on the main branch of the deployer repo and that the GitHub App may run Actions there.'); finished++ }
        continue
      }
      if (!b.runId) { patchBuild(b.id, { status: 'building', runId: run.id, runUrl: run.url }); run = { ...run } }
      if (run.status !== 'completed') {
        if (age > BUILD_MAX_MS) { failed(b, 'The build took longer than 45 minutes and was given up on.'); finished++ }
        continue
      }
      finished++
      if (run.conclusion !== 'success') {
        failed(b, run.conclusion === 'cancelled' ? 'The build was cancelled on GitHub.' : 'The build failed. Open the GitHub log to see why.')
        continue
      }
      patchBuild(b.id, { status: 'done', finished: true })
      const club = getClub(b.clubId)
      if (club) afterImage(club, b.image, b.message, b.reason, b.createdBy)
    } catch (err) {
      // GitHub hiccups: try again on the next pass (the time limits still apply).
      console.error(`[apps] build ${b.id}:`, (err as Error).message)
      if (age > BUILD_MAX_MS) { failed(b, (err as Error).message); finished++ }
    }
  }
  return finished
}

const g = globalThis as unknown as { __buildTimer?: NodeJS.Timeout; __buildBusy?: boolean }

async function tick() {
  if (g.__buildBusy) return
  g.__buildBusy = true
  try { await pollBuilds() } catch (err) { console.error('[apps]', (err as Error).message) } finally { g.__buildBusy = false }
}

/** Starts the 10-second build watcher (once per process). */
export function startBuildPoller() {
  if (g.__buildTimer || process.env.VITEST) return
  g.__buildTimer = setInterval(() => { void tick() }, 10_000)
  g.__buildTimer.unref?.()
}
function kickBuildPoller() {
  if (!process.env.VITEST) startBuildPoller()
}

// ── Push notices ─────────────────────────────────────────────────────────────
export type PushEvent = {
  ref?: string
  after?: string
  deleted?: boolean
  repository?: { full_name?: string }
  head_commit?: { message?: string } | null
  pusher?: { name?: string }
}

/** A push to a branch an app follows: build and deploy it. Returns the apps it started. */
export async function handlePush(event: PushEvent): Promise<string[]> {
  const repo = (event.repository?.full_name ?? '').toLowerCase()
  const ref = event.ref ?? ''
  if (!repo || !ref.startsWith('refs/heads/') || event.deleted || !/^[0-9a-f]{40}$/.test(event.after ?? '')) return []
  const branch = ref.slice('refs/heads/'.length)
  const by = `GitHub push${event.pusher?.name ? ` by ${event.pusher.name}` : ''}`.slice(0, 80)
  const started: string[] = []
  for (const club of listClubs()) {
    if (!isApp(club) || !club.appAutoDeploy || club.status !== 'running') continue
    if (club.appRepo.toLowerCase() !== repo || club.appBranch !== branch) continue
    try {
      await startBuild(club, { by, reason: 'deploy', sha: event.after, message: event.head_commit?.message ?? '' })
      started.push(club.name)
    } catch (err) {
      console.error(`[apps] push to ${repo}#${branch} for ${club.name}:`, (err as Error).message)
    }
  }
  return started
}
