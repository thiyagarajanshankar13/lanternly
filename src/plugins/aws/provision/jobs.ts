import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { utils as sshUtils } from 'ssh2'
import { db, now } from '@/lib/db'
import { randomToken, sha256 } from '@/lib/crypto'
import { getServer, listServers, saveServer } from '@/lib/clubs'
import { isFakeEngine, runner, type ServerRow } from '@/lib/engine'
import { mailReady, sendMail } from '@/lib/mail'
import { alertRecipients } from '@/lib/monitor'
import { displayLocale, getSettings, saveSettings } from '@/lib/settings'
import { awsErrorText } from '@/plugins/aws/costs/aws'
import { costCurrency, displayRate, latestSnapshot } from '@/plugins/aws/costs/service'
import { currencySymbol, type CurrencyCode } from '../money'
import { lightsail, type BundleInfo } from './lightsail'
import {
  BOOT_MINUTES, SNAPSHOT_KEEP_DAYS, budgetCheck, finalSnapshotName, isIpv4, lightsailNameFor, limitError, parseDone, portRules,
  serverNameError, setupScript, sizeFor, sizeOptions, staticIpNameFor, userData, type AgentFile, type BudgetCheck, type SizeOption,
} from './plan'

// Servers the deployer makes and deletes in Lightsail. Each create or delete
// is a row in server_jobs, moved one step at a time by a timer, so a restart
// carries on where it stopped. The new VM fetches its setup from
// /api/provision/<job>/script with a one-time code and reports its host key
// back; the deployer then checks it can reach clubctl before adding the server.

export type JobKind = 'create' | 'delete'
export type JobStatus = 'running' | 'ready' | 'failed' | 'discarded'

export type ServerJob = {
  id: number; kind: JobKind; name: string; lightsailName: string; bundleId: string; ramGb: number; priceUsd: number
  purpose: 'sites' | 'apps'; maxClubs: number; status: JobStatus; step: string; log: string; ips: string[]
  staticIpName: string; staticIp: string; hostKey: string; snapshotName: string; serverId: number | null
  deadline: string; createdBy: string; createdAt: string; updatedAt: string; finishedAt: string | null
}
type JobRow = {
  id: number; kind: string; name: string; lightsail_name: string; bundle_id: string; ram_gb: number; price_usd: number; purpose: string
  max_clubs: number; status: string; step: string; log: string; token_hash: string; ips: string; static_ip_name: string; static_ip: string
  host_key: string; snapshot_name: string; server_id: number | null; deadline: string; created_by: string; created_at: string; updated_at: string; finished_at: string | null
}
const toJob = (r: JobRow): ServerJob => ({
  id: r.id, kind: r.kind as JobKind, name: r.name, lightsailName: r.lightsail_name, bundleId: r.bundle_id, ramGb: r.ram_gb, priceUsd: r.price_usd,
  purpose: r.purpose === 'apps' ? 'apps' : 'sites', maxClubs: r.max_clubs, status: r.status as JobStatus, step: r.step, log: r.log,
  ips: safeList(r.ips), staticIpName: r.static_ip_name, staticIp: r.static_ip, hostKey: r.host_key, snapshotName: r.snapshot_name,
  serverId: r.server_id, deadline: r.deadline, createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at, finishedAt: r.finished_at,
})
function safeList(json: string): string[] { try { const v = JSON.parse(json); return Array.isArray(v) ? v.map(String) : [] } catch { return [] } }

export const STEP_LABELS: Record<string, string> = {
  create: 'Asking Lightsail for the VM', starting: 'Waiting for the VM to start', ip: 'Giving it a static IP', ports: 'Opening ports 80 and 443 (SSH only from the deployer)',
  booting: 'Waiting for the VM to fetch its setup', setup: 'Installing Docker, Postgres, Caddy and clubctl', checking: 'Checking the deployer can reach it',
  snapshot: 'Taking a last snapshot', 'snapshot-wait': 'Waiting for the snapshot', delete: 'Deleting the VM', release: 'Releasing its static IP',
  cleanup: 'Deleting the half-made VM', done: 'Done',
}

export function getJob(id: number): ServerJob | null {
  const r = db().prepare('SELECT * FROM server_jobs WHERE id = ?').get(id) as JobRow | undefined
  return r ? toJob(r) : null
}
export function listJobs(limit = 20): ServerJob[] {
  return (db().prepare('SELECT * FROM server_jobs ORDER BY id DESC LIMIT ?').all(limit) as JobRow[]).map(toJob)
}
export const activeJobs = (): ServerJob[] => (db().prepare("SELECT * FROM server_jobs WHERE status = 'running' ORDER BY id").all() as JobRow[]).map(toJob)

function timeText(): string {
  try { return new Date().toLocaleTimeString('en-GB', { timeZone: getSettings().defaultTimezone || 'UTC', hour12: false }) } catch { return new Date().toISOString().slice(11, 19) }
}
function log(id: number, line: string) {
  const text = line.split('\n').map((l) => `[${timeText()}] ${l}`).join('\n') + '\n'
  db().prepare("UPDATE server_jobs SET log = substr(log || ?, -60000), updated_at = ? WHERE id = ?").run(text, now(), id)
}
function setStep(id: number, step: string, extra: Partial<Record<'ips' | 'static_ip' | 'static_ip_name' | 'host_key' | 'snapshot_name' | 'deadline' | 'server_id', string | number | null>> = {}) {
  const sets = ['step = ?', 'updated_at = ?']
  const vals: (string | number | null)[] = [step, now()]
  for (const [k, v] of Object.entries(extra)) { sets.push(`${k} = ?`); vals.push(v ?? null) }
  db().prepare(`UPDATE server_jobs SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id)
  if (STEP_LABELS[step]) log(id, STEP_LABELS[step])
}
function finish(id: number, status: JobStatus, message: string) {
  log(id, message)
  db().prepare("UPDATE server_jobs SET status = ?, token_hash = '', finished_at = ?, updated_at = ? WHERE id = ?").run(status, now(), now(), id)
}

// ── What the deployer needs to make a server ─────────────────────────────────

const deployerUrl = () => (process.env.DEPLOYER_URL || '').replace(/\/+$/, '')

/** The public half of the deployer's SSH key, for the new server's authorized_keys. */
export function deployerPublicKey(): string {
  const file = process.env.DEPLOYER_SSH_KEY_FILE
  if (file && fs.existsSync(`${file}.pub`)) return fs.readFileSync(`${file}.pub`, 'utf8').trim().split(/\s+/).slice(0, 2).join(' ')
  const inline = (process.env.DEPLOYER_SSH_KEY || '').replace(/\\n/g, '\n').trim()
  const pem = inline || (file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '')
  if (pem) {
    const key = sshUtils.parseKey(pem)
    const k = Array.isArray(key) ? key[0] : key
    if (k instanceof Error) throw new Error(`The deployer's SSH key can't be read: ${k.message}`)
    return `${k.type} ${k.getPublicSSH().toString('base64')}`
  }
  if (isFakeEngine()) return 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyForTestsOnlyFakeKeyForTestsOnly00'
  throw new Error('No SSH key: set DEPLOYER_SSH_KEY_FILE (or DEPLOYER_SSH_KEY).')
}

/** agent/ as shipped in the deployer's image (clubctl, its files and the setup script). */
export function agentFiles(dir = process.env.DEPLOYER_AGENT_DIR || path.join(process.cwd(), 'agent')): AgentFile[] {
  if (!fs.existsSync(path.join(dir, 'setup-clubs-vm.sh'))) throw new Error(`The server setup files aren't in ${dir}.`)
  const out: AgentFile[] = []
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(p)
      else if (e.isFile()) out.push({ path: p, mode: fs.statSync(path.join(dir, p)).mode, content: fs.readFileSync(path.join(dir, p)) })
    }
  }
  walk('')
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

/** Everything that has to be in place before a server can be made, as plain sentences. */
export function missingSetup(): string[] {
  const s = getSettings()
  const out: string[] = []
  if (!lightsail()) out.push('Add the AWS key for new servers.')
  if (!deployerUrl().startsWith('https://')) out.push('DEPLOYER_URL must be the deployer\'s https:// address, so a new server can fetch its setup.')
  if (!s.provisionAcmeEmail) out.push('Add the email for HTTPS certificate notices.')
  if (!s.provisionGhcrToken || !s.provisionGhcrUser) out.push('Add the GitHub user and package token new servers pull private images with.')
  try { deployerPublicKey() } catch (err) { out.push((err as Error).message) }
  try { agentFiles() } catch (err) { out.push((err as Error).message) }
  return out
}

const g = globalThis as unknown as { __bundles?: { at: number; list: BundleInfo[] }; __rate?: { at: number; value: Awaited<ReturnType<typeof displayRate>> }; __provisionTimer?: NodeJS.Timeout; __provisionBusy?: boolean; __provisionDaily?: NodeJS.Timeout; __ipFetcher?: () => Promise<string> }
export function clearPriceCache() { g.__bundles = undefined; g.__rate = undefined }
export function setIpFetcherForTests(f: (() => Promise<string>) | undefined) { g.__ipFetcher = f }

/** The sizes with their prices (from Lightsail, kept an hour) and the rate to the currency costs are shown in. */
export async function priceList(): Promise<{ options: SizeOption[]; rate: number; currency: CurrencyCode; rateNote: string; error: string }> {
  // The page refreshes every few seconds while a server is being made: ask for the rate at most hourly.
  if (!g.__rate || Date.now() - g.__rate.at > 3_600_000) g.__rate = { at: Date.now(), value: await displayRate() }
  const { rate, currency, rateSource, rateDate } = g.__rate.value
  const sym = currencySymbol(currency)
  const rateNote = currency === 'USD' ? 'US$, as AWS bills' : rateSource === 'typed' ? `${sym}${rate.toFixed(4)} per US$ (typed under Costs)` : rateSource === 'daily' ? `${sym}${rate.toFixed(4)} per US$ (${rateDate})` : `${sym}${rate.toFixed(2)} per US$ (${rateSource} rate)`
  const api = lightsail()
  if (!api) return { options: [], rate, currency, rateNote, error: 'Add the AWS key for new servers first.' }
  try {
    if (!g.__bundles || Date.now() - g.__bundles.at > 3_600_000) g.__bundles = { at: Date.now(), list: await api.bundles() }
    return { options: sizeOptions(g.__bundles.list), rate, currency, rateNote, error: '' }
  } catch (err) {
    return { options: [], rate, currency, rateNote, error: `Lightsail didn't give its prices: ${awsErrorText(err)}` }
  }
}

/** Plan prices of every Lightsail VM and bucket today (US$ a month), from the last Costs fetch. Null when Costs has never run. */
export function currentPlansUsd(): number | null {
  const snap = latestSnapshot()
  return snap ? snap.resources.reduce((t, r) => t + r.monthlyUsd, 0) : null
}

/** Servers the deployer made (still there) plus the ones it's making now. */
export function managedCount(): number {
  const servers = (db().prepare("SELECT COUNT(*) AS n FROM servers WHERE lightsail_name <> ''").get() as { n: number }).n
  const making = (db().prepare("SELECT COUNT(*) AS n FROM server_jobs WHERE kind = 'create' AND status = 'running'").get() as { n: number }).n
  return servers + making
}

export async function budgetFor(addUsd: number): Promise<BudgetCheck> {
  const { rate, currency } = await priceList()
  // The budget is in the chosen currency: with no rate for it (shown in US$), there's nothing to compare.
  const budget = currency === costCurrency() ? getSettings().costBudget : 0
  return budgetCheck({ currentUsd: currentPlansUsd() ?? 0, addUsd, rate, budget, currency, locale: displayLocale() })
}

async function fetchOwnIp(): Promise<string> {
  if (g.__ipFetcher) return g.__ipFetcher()
  if (isFakeEngine()) return '192.0.2.10'
  const res = await fetch('https://checkip.amazonaws.com', { signal: AbortSignal.timeout(10_000) })
  return (await res.text()).trim()
}

/** The deployer's own public IP: typed, else looked up once and kept. */
export async function deployerIp(): Promise<string> {
  const typed = getSettings().provisionDeployerIp
  if (typed) return typed
  const ip = await fetchOwnIp()
  if (!isIpv4(ip)) throw new Error('Couldn\'t find the deployer\'s public IP. Type it under "AWS for new servers".')
  saveSettings({ provisionDeployerIp: ip })
  return ip
}

// ── Starting a create or a delete ───────────────────────────────────────────

export type CreateRequest = { name: string; ramGb: number; maxClubs?: number; overBudget?: boolean; by: string }

/** Starts making a server. Returns the job, or why not. */
export async function startCreate(req: CreateRequest): Promise<{ job?: ServerJob; error?: string }> {
  const name = req.name.trim()
  const nameErr = serverNameError(name)
  if (nameErr) return { error: nameErr }
  const missing = missingSetup()
  if (missing.length) return { error: missing.join(' ') }
  const size = sizeFor(req.ramGb)
  if (!size) return { error: 'Pick one of the sizes.' }
  const { options, error } = await priceList()
  if (error) return { error }
  const option = options.find((o) => o.ramGb === size.ramGb)
  if (!option) return { error: `Lightsail has no ${size.ramGb} GB plan in this region.` }
  const s = getSettings()
  const limit = limitError(managedCount(), s.provisionMaxServers)
  if (limit) return { error: limit }
  const budget = await budgetFor(option.bundle.priceUsd)
  if (budget.over && !req.overBudget) return { error: `This would take the monthly plans to ${budget.money(budget.afterCost)}, over the ${budget.money(budget.budget)} budget. Tick "Go over the budget" to make it anyway.` }
  const lsName = lightsailNameFor(name)
  if (listServers().some((x) => x.name.toLowerCase() === name.toLowerCase())) return { error: 'A server with that name already exists.' }
  if (db().prepare("SELECT 1 FROM servers WHERE lightsail_name = ? UNION SELECT 1 FROM server_jobs WHERE lightsail_name = ? AND kind = 'create' AND status = 'running'").get(lsName, lsName)) {
    return { error: `The Lightsail name ${lsName} is taken. Pick another name.` }
  }
  try {
    if (await lightsail()!.getInstance(lsName)) return { error: `Lightsail already has a VM called ${lsName}. Pick another name.` }
    await deployerIp()
  } catch (err) {
    return { error: awsErrorText(err) }
  }
  const maxClubs = size.purpose === 'apps' ? 1 : Math.max(1, Math.min(500, Math.round(req.maxClubs ?? size.maxSites)))
  const info = db().prepare(
    `INSERT INTO server_jobs (kind, name, lightsail_name, bundle_id, ram_gb, price_usd, purpose, max_clubs, status, step, static_ip_name, created_by, created_at, updated_at)
     VALUES ('create', ?, ?, ?, ?, ?, ?, ?, 'running', 'create', ?, ?, ?, ?)`,
  ).run(name, lsName, option.bundle.bundleId, option.ramGb, option.bundle.priceUsd, size.purpose, maxClubs, staticIpNameFor(lsName), req.by, now(), now())
  const id = Number(info.lastInsertRowid)
  log(id, `${req.by} asked for ${name}: ${option.ramGb} GB, ${option.bundle.cpus} vCPU, ${option.bundle.diskGb} GB disk, US$${option.bundle.priceUsd}/month (${budget.text})${budget.over ? ' Over the budget, on purpose.' : ''}`)
  kickProvision()
  return { job: getJob(id)! }
}

/** Why this server can't be deleted, or null. */
export function deleteError(server: ServerRow): string | null {
  if (!server.lightsail_name) return 'The deployer didn\'t make this server, so it only removes its record. Delete the VM in Lightsail yourself.'
  const n = (sql: string) => (db().prepare(sql).get(server.id) as { n: number }).n
  if (n('SELECT COUNT(*) AS n FROM clubs WHERE server_id = ?') > 0) return 'Move or remove its sites, apps and databases first.'
  if (n('SELECT COUNT(*) AS n FROM projects WHERE server_id = ?') > 0) return 'Move or remove its projects first.'
  if (db().prepare("SELECT 1 FROM server_jobs WHERE server_id = ? AND status = 'running'").get(server.id)) return 'It is already being deleted.'
  return null
}

export const isBeingDeleted = (serverId: number) => !!db().prepare("SELECT 1 FROM server_jobs WHERE kind = 'delete' AND server_id = ? AND status = 'running'").get(serverId)

export function startDelete(serverId: number, by: string): { job?: ServerJob; error?: string } {
  const server = getServer(serverId)
  if (!server) return { error: 'No such server.' }
  const err = deleteError(server)
  if (err) return { error: err }
  if (!lightsail()) return { error: 'Add the AWS key for new servers first.' }
  const lsName = server.lightsail_name ?? ''
  db().prepare('UPDATE servers SET accepts_new = 0 WHERE id = ?').run(server.id)
  const info = db().prepare(
    `INSERT INTO server_jobs (kind, name, lightsail_name, bundle_id, price_usd, purpose, max_clubs, status, step, static_ip_name, server_id, snapshot_name, created_by, created_at, updated_at)
     VALUES ('delete', ?, ?, ?, ?, ?, ?, 'running', 'snapshot', ?, ?, ?, ?, ?, ?)`,
  ).run(server.name, lsName, server.bundle_id ?? '', server.price_usd ?? 0, server.purpose ?? 'sites', server.max_clubs,
    staticIpNameFor(lsName), server.id, finalSnapshotName(lsName, new Date()), by, now(), now())
  const id = Number(info.lastInsertRowid)
  log(id, `${by} asked to delete ${server.name} (${server.lightsail_name}). A snapshot is kept ${SNAPSHOT_KEEP_DAYS} days.`)
  kickProvision()
  return { job: getJob(id)! }
}

/** Retries a failed job from the step it failed on (a create that never booted can only be discarded). */
export function retryJob(id: number, by: string): string | null {
  const job = getJob(id)
  if (!job || job.status !== 'failed') return 'Only a failed job can be retried.'
  if (job.kind === 'create' && (job.step === 'booting' || job.step === 'setup')) return 'The VM\'s first-boot setup can\'t be run again. Discard it and create the server again.'
  db().prepare("UPDATE server_jobs SET status = 'running', finished_at = NULL, updated_at = ? WHERE id = ?").run(now(), id)
  log(id, `${by} retried from "${STEP_LABELS[job.step] ?? job.step}"`)
  kickProvision()
  return null
}

/** Deletes whatever a failed create left behind in Lightsail (no snapshot: nothing ran on it). */
export function discardJob(id: number, by: string): string | null {
  const job = getJob(id)
  if (!job || job.kind !== 'create' || job.status !== 'failed') return 'Only a failed create can be discarded.'
  db().prepare("UPDATE server_jobs SET status = 'running', step = 'cleanup', finished_at = NULL, token_hash = '', updated_at = ? WHERE id = ?").run(now(), id)
  log(id, `${by} discarded it`)
  kickProvision()
  return null
}

// ── The VM calling back ──────────────────────────────────────────────────────

export type CallbackAuth = { ok: true; job: ServerJob } | { ok: false; status: number }

/** A request from a new VM: the job's one-time code, from one of the VM's own addresses, while it's waiting for it. */
export function authorizeCallback(id: number, token: string, ip: string): CallbackAuth {
  const r = Number.isInteger(id) ? (db().prepare('SELECT * FROM server_jobs WHERE id = ?').get(id) as JobRow | undefined) : undefined
  if (!r || !r.token_hash || !token) return { ok: false, status: 404 }
  const a = Buffer.from(sha256(token)); const b = Buffer.from(r.token_hash)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, status: 404 }
  const job = toJob(r)
  if (job.status !== 'running' || (job.step !== 'booting' && job.step !== 'setup')) return { ok: false, status: 409 }
  if (!job.ips.includes(ip)) return { ok: false, status: 403 }
  return { ok: true, job }
}

/** The setup script for the VM (marks the job as setting up). */
export function scriptFor(job: ServerJob, token: string): string {
  const s = getSettings()
  if (job.step === 'booting') setStep(job.id, 'setup')
  return setupScript({
    deployerUrl: deployerUrl(), jobId: job.id, token, files: agentFiles(), deployerPublicKey: deployerPublicKey(),
    acmeEmail: s.provisionAcmeEmail, ghcrUser: s.provisionGhcrUser, ghcrToken: s.provisionGhcrToken,
  })
}

export function progressFrom(job: ServerJob, body: string) {
  const line = body.replace(/[^\x20-\x7E\n]/g, '').trim().slice(0, 300)
  if (line) log(job.id, `  ${line.replace(/^==> /, '')}`)
}

/** The VM finished: keep its host key and go on to checking, or fail with its last lines. */
export function doneFrom(job: ServerJob, body: string) {
  const r = parseDone(body.slice(0, 20000))
  if (!r.ok) { finish(job.id, 'failed', r.error); return }
  db().prepare("UPDATE server_jobs SET token_hash = '' WHERE id = ?").run(job.id)
  setStep(job.id, 'checking', { host_key: r.hostKey })
  log(job.id, `  Host key ${r.hostKey.slice(0, 40)}…`)
  kickProvision()
}

// ── Moving jobs along ────────────────────────────────────────────────────────

/** Moves one job on by at most one step. */
async function advance(job: ServerJob): Promise<void> {
  const api = lightsail()
  if (!api) { finish(job.id, 'failed', 'The AWS key for new servers was removed.'); return }
  try {
    if (job.kind === 'create') await advanceCreate(job, api)
    else await advanceDelete(job, api)
  } catch (err) {
    finish(job.id, 'failed', `!! ${awsErrorText(err)}`)
  }
}

async function advanceCreate(job: ServerJob, api: NonNullable<ReturnType<typeof lightsail>>) {
  switch (job.step) {
    case 'create': {
      const token = randomToken(32)
      db().prepare('UPDATE server_jobs SET token_hash = ? WHERE id = ?').run(sha256(token), job.id)
      if (!(await api.getInstance(job.lightsailName))) {
        await api.createInstance({
          name: job.lightsailName, zone: getSettings().provisionZone || 'ap-southeast-2a', bundleId: job.bundleId,
          userData: userData({ deployerUrl: deployerUrl(), jobId: job.id, token }), tags: { 'avro-server': job.name.replace(/[^A-Za-z0-9 ._-]/g, '') },
        })
      }
      setStep(job.id, 'starting', { deadline: new Date(Date.now() + BOOT_MINUTES * 60_000).toISOString() })
      return
    }
    case 'starting': {
      const vm = await api.getInstance(job.lightsailName)
      if (!vm) throw new Error(`Lightsail has no VM called ${job.lightsailName} any more.`)
      if (vm.state !== 'running') { if (timedOut(job)) finish(job.id, 'failed', `!! The VM was still "${vm.state}" after ${BOOT_MINUTES} minutes.`); return }
      setStep(job.id, 'ip', { ips: JSON.stringify([...new Set([...job.ips, vm.publicIp].filter(Boolean))]) })
      return
    }
    case 'ip': {
      await api.allocateStaticIp(job.staticIpName)
      const ip = await api.getStaticIp(job.staticIpName)
      if (ip?.attachedTo !== job.lightsailName) await api.attachStaticIp(job.staticIpName, job.lightsailName)
      const after = await api.getStaticIp(job.staticIpName)
      if (!after?.ip) throw new Error('Lightsail gave no address for the static IP.')
      log(job.id, `  Static IP ${after.ip}`)
      setStep(job.id, 'ports', { static_ip: after.ip, ips: JSON.stringify([...new Set([...job.ips, after.ip])]) })
      return
    }
    case 'ports': {
      await api.setPorts(job.lightsailName, portRules(await deployerIp()))
      setStep(job.id, 'booting')
      return
    }
    case 'booting':
    case 'setup': {
      // The VM moves these on itself (script fetched → setup, done → checking).
      if (timedOut(job)) finish(job.id, 'failed', `!! The VM didn't ${job.step === 'booting' ? 'fetch its setup' : 'finish its setup'} within ${BOOT_MINUTES} minutes. Discard it and try again; /var/log/avro-setup.log on the VM says why.`)
      return
    }
    case 'checking': {
      const probe: ServerRow = {
        id: 0, name: job.name, host: job.staticIp, port: 22, username: 'deployer', host_key: job.hostKey, public_ip: job.staticIp,
        max_clubs: job.maxClubs, accepts_new: 1,
      }
      const res = await runner()(probe, ['host'])
      if (res.code !== 0) throw new Error(`clubctl on the new server answered: ${res.output.trim().slice(0, 300)}`)
      const serverId = saveServer({
        name: job.name, host: job.staticIp, port: 22, username: 'deployer', hostKey: job.hostKey, publicIp: job.staticIp,
        maxClubs: job.maxClubs, acceptsNew: true, memoryMb: Math.round(job.ramGb * 1024),
      })
      db().prepare('UPDATE servers SET lightsail_name = ?, purpose = ?, bundle_id = ?, price_usd = ? WHERE id = ?').run(job.lightsailName, job.purpose, job.bundleId, job.priceUsd, serverId)
      setStep(job.id, 'done', { server_id: serverId })
      finish(job.id, 'ready', `${job.name} is ready at ${job.staticIp} and takes new ${job.purpose === 'apps' ? 'apps' : 'sites'}.`)
      return
    }
    case 'cleanup': {
      await api.deleteInstance(job.lightsailName)
      await api.releaseStaticIp(job.staticIpName)
      finish(job.id, 'discarded', `Deleted ${job.lightsailName} and released its static IP.`)
      return
    }
  }
}

async function advanceDelete(job: ServerJob, api: NonNullable<ReturnType<typeof lightsail>>) {
  switch (job.step) {
    case 'snapshot': {
      const server = job.serverId ? getServer(job.serverId) : null
      if (server) { const err = deleteError(server); if (err && !/already being deleted/.test(err)) { finish(job.id, 'failed', `!! ${err}`); return } }
      if (!(await api.getInstance(job.lightsailName))) { setStep(job.id, 'release'); return }
      if (!(await api.snapshotState(job.snapshotName))) await api.createSnapshot(job.lightsailName, job.snapshotName, { 'avro-server': job.name.replace(/[^A-Za-z0-9 ._-]/g, '') })
      setStep(job.id, 'snapshot-wait', { deadline: new Date(Date.now() + 60 * 60_000).toISOString() })
      return
    }
    case 'snapshot-wait': {
      const state = await api.snapshotState(job.snapshotName)
      if (state === 'available') {
        db().prepare('INSERT OR IGNORE INTO server_snapshots (server_name, snapshot_name, created_by, created_at, delete_after) VALUES (?, ?, ?, ?, ?)')
          .run(job.name, job.snapshotName, job.createdBy, now(), new Date(Date.now() + SNAPSHOT_KEEP_DAYS * 86_400_000).toISOString())
        setStep(job.id, 'delete')
      } else if (state === 'error' || state === null) throw new Error(`The snapshot ${job.snapshotName} ${state ? 'failed' : 'disappeared'}, so the VM was not deleted.`)
      else if (timedOut(job)) throw new Error('The snapshot took over an hour, so the VM was not deleted. Retry to keep waiting.')
      return
    }
    case 'delete': {
      await api.deleteInstance(job.lightsailName)
      setStep(job.id, 'release')
      return
    }
    case 'release': {
      await api.releaseStaticIp(job.staticIpName)
      if (job.serverId) db().prepare('DELETE FROM servers WHERE id = ?').run(job.serverId)
      setStep(job.id, 'done')
      finish(job.id, 'ready', `${job.name} is deleted. Its snapshot ${job.snapshotName} is kept until ${new Date(Date.now() + SNAPSHOT_KEEP_DAYS * 86_400_000).toLocaleDateString(displayLocale())}.`)
      return
    }
  }
}

const timedOut = (job: ServerJob) => !!job.deadline && Date.now() > new Date(job.deadline).getTime()

/** Moves every running job on by one step. Returns when done (tests call it directly). */
export async function tickProvision(): Promise<void> {
  if (g.__provisionBusy) return
  g.__provisionBusy = true
  try {
    for (const job of activeJobs()) await advance(job)
  } finally { g.__provisionBusy = false }
}

/** Runs a few ticks soon after a change, so steps don't wait for the timer. */
export function kickProvision() {
  if (process.env.VITEST) return
  setTimeout(() => void tickProvision(), 200).unref?.()
}

// ── Daily: expired snapshots and VMs tagged as ours that the deployer doesn't know ──

export type UnknownCheck = { at: string; unknown: string[]; error: string }
export function lastCheck(): UnknownCheck | null {
  try { return getSettings().provisionCheck ? (JSON.parse(getSettings().provisionCheck) as UnknownCheck) : null } catch { return null }
}

export function listSnapshots(): { serverName: string; snapshotName: string; createdAt: string; deleteAfter: string }[] {
  return (db().prepare('SELECT * FROM server_snapshots WHERE deleted_at IS NULL ORDER BY id DESC').all() as { server_name: string; snapshot_name: string; created_at: string; delete_after: string }[])
    .map((r) => ({ serverName: r.server_name, snapshotName: r.snapshot_name, createdAt: r.created_at, deleteAfter: r.delete_after }))
}

export async function dailyCheck(at = new Date()): Promise<UnknownCheck | null> {
  const api = lightsail()
  if (!api) return null
  const out: UnknownCheck = { at: at.toISOString(), unknown: [], error: '' }
  try {
    for (const s of db().prepare('SELECT snapshot_name FROM server_snapshots WHERE deleted_at IS NULL AND delete_after < ?').all(at.toISOString()) as { snapshot_name: string }[]) {
      await api.deleteSnapshot(s.snapshot_name)
      db().prepare('UPDATE server_snapshots SET deleted_at = ? WHERE snapshot_name = ?').run(now(), s.snapshot_name)
    }
    const known = new Set([
      ...(db().prepare("SELECT lightsail_name FROM servers WHERE lightsail_name <> ''").all() as { lightsail_name: string }[]).map((r) => r.lightsail_name),
      ...activeJobs().map((j) => j.lightsailName),
    ])
    out.unknown = (await api.managedInstances()).map((i) => i.name).filter((n) => !known.has(n)).sort()
  } catch (err) {
    out.error = awsErrorText(err)
  }
  const before = lastCheck()
  saveSettings({ provisionCheck: JSON.stringify(out) })
  const fresh = out.unknown.filter((n) => !(before?.unknown ?? []).includes(n))
  if (fresh.length && mailReady()) {
    await sendMail(alertRecipients(), `Lightsail has ${fresh.length} VM${fresh.length === 1 ? '' : 's'} the deployer doesn't know`,
      `These Lightsail VMs are tagged avro-managed but aren't servers in the deployer:\n\n${fresh.map((n) => `  ${n}`).join('\n')}\n\nThey still cost money. Add them under Servers, or delete them in Lightsail if nothing needs them.\n`)
  }
  return out
}

/** Every 5 seconds while a job is running, plus the daily check. DEPLOYER_PROVISION=off stops it. */
export function startProvisionScheduler() {
  if (g.__provisionTimer || /^(0|false|no|off)$/i.test(process.env.DEPLOYER_PROVISION || '')) return
  g.__provisionTimer = setInterval(() => { if (activeJobs().length) void tickProvision() }, 5000)
  g.__provisionTimer.unref?.()
  const daily = async () => {
    const last = lastCheck()
    if (last && Date.now() - new Date(last.at).getTime() < 23 * 3_600_000) return
    try { await dailyCheck() } catch (err) { console.error('[provision]', (err as Error).message) }
  }
  g.__provisionDaily = setInterval(() => void daily(), 3_600_000)
  g.__provisionDaily.unref?.()
  setTimeout(() => void daily(), 90_000).unref?.()
}
