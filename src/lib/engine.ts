import fs from 'node:fs'
import { Client } from 'ssh2'
import crypto from 'node:crypto'
import { PassThrough, Readable } from 'node:stream'

// Talks to clubctl on a sites VM. The SSH key is locked to clubctl on the VM
// (see agent/clubctl-ssh), so this never gets a shell.

export type ServerRow = {
  id: number
  name: string
  host: string
  port: number
  username: string
  host_key: string
  public_ip: string
  max_clubs: number
  /** Memory of the VM in MB (0 = not entered); used to check there is room for a new service. */
  memory_mb?: number
  accepts_new: number
  /** Set when the deployer made this VM in Lightsail itself (its Lightsail name). */
  lightsail_name?: string
  /** 'apps': a small server for apps only; Avrosphere sites aren't placed on it. */
  purpose?: string
  bundle_id?: string
  /** Its Lightsail plan's price, US$ a month (servers the deployer made). */
  price_usd?: number
}

export type RunResult = { code: number; output: string }
export type Runner = (server: ServerRow, args: string[], stdin?: string, onOutput?: (chunk: string) => void) => Promise<RunResult>

/** A clubctl call whose stdout is data (backups): read `stdout`, then await `done`. */
export type StreamCall = { stdout: Readable; done: Promise<{ code: number; stderr: string }> }
export type StreamRunner = (server: ServerRow, args: string[], stdin?: Readable | Buffer | string, onStderr?: (chunk: string) => void) => Promise<StreamCall>

const WORD = /^[A-Za-z0-9._:/@,-]+$/

function privateKey(): string {
  const inline = (process.env.DEPLOYER_SSH_KEY || '').replace(/\\n/g, '\n').trim()
  if (inline) return inline + '\n'
  const file = process.env.DEPLOYER_SSH_KEY_FILE
  if (file) return fs.readFileSync(file, 'utf8')
  throw new Error('No SSH key: set DEPLOYER_SSH_KEY_FILE (or DEPLOYER_SSH_KEY)')
}

/** "ssh-ed25519 AAAA…" as pasted from setup-clubs-vm.sh → the raw key bytes. */
function expectedHostKey(stored: string): Buffer | null {
  const parts = stored.trim().split(/\s+/)
  const b64 = parts.find((p) => /^AAAA[A-Za-z0-9+/=]+$/.test(p))
  return b64 ? Buffer.from(b64, 'base64') : null
}

export const sshRunner: Runner = (server, args, stdin, onOutput) =>
  new Promise((resolve, reject) => {
    for (const a of args) if (!WORD.test(a)) return reject(new Error(`Refusing to send an unsafe word to clubctl: ${a.slice(0, 40)}`))
    const want = expectedHostKey(server.host_key)
    if (!want) return reject(new Error(`Server "${server.name}" has no host key saved, so its identity can't be checked.`))
    const conn = new Client()
    let output = ''
    let settled = false
    const finish = (fn: () => void) => { if (!settled) { settled = true; conn.end(); fn() } }
    conn
      .on('ready', () => {
        conn.exec(args.join(' '), (err, stream) => {
          if (err) return finish(() => reject(err))
          const take = (d: Buffer) => { const s = d.toString('utf8'); output += s; onOutput?.(s) }
          stream.on('data', take)
          stream.stderr.on('data', take)
          stream.on('close', (code: number | null) => finish(() => resolve({ code: code ?? 1, output })))
          stream.end(stdin ?? '')
        })
      })
      .on('error', (err) => finish(() => reject(new Error(`Can't reach ${server.name} (${server.host}): ${err.message}`))))
      .connect({
        host: server.host,
        port: server.port,
        username: server.username,
        privateKey: privateKey(),
        readyTimeout: 20000,
        keepaliveInterval: 15000,
        hostVerifier: (key: Buffer) => key.length === want.length && crypto.timingSafeEqual(key, want),
      })
  })


export function connectTo(server: ServerRow): Promise<Client> {
  return new Promise((resolve, reject) => {
    const want = expectedHostKey(server.host_key)
    if (!want) return reject(new Error(`Server "${server.name}" has no host key saved, so its identity can't be checked.`))
    const conn = new Client()
    conn
      .on('ready', () => resolve(conn))
      .on('error', (err) => reject(new Error(`Can't reach ${server.name} (${server.host}): ${err.message}`)))
      .connect({
        host: server.host, port: server.port, username: server.username, privateKey: privateKey(),
        readyTimeout: 20000, keepaliveInterval: 15000,
        hostVerifier: (key: Buffer) => key.length === want.length && crypto.timingSafeEqual(key, want),
      })
  })
}

export const sshStreamRunner: StreamRunner = async (server, args, stdin, onStderr) => {
  for (const a of args) if (!WORD.test(a)) throw new Error(`Refusing to send an unsafe word to clubctl: ${a.slice(0, 40)}`)
  const conn = await connectTo(server)
  return new Promise((resolve, reject) => {
    conn.exec(args.join(' '), (err, channel) => {
      if (err) { conn.end(); return reject(err) }
      let stderr = ''
      channel.stderr.on('data', (d: Buffer) => { const t = d.toString('utf8'); stderr = (stderr + t).slice(-20000); onStderr?.(t) })
      const stdout = new PassThrough()
      channel.pipe(stdout)
      const done = new Promise<{ code: number; stderr: string }>((res) => {
        channel.on('close', (code: number | null) => { conn.end(); res({ code: code ?? 1, stderr }) })
      })
      conn.on('error', (e) => stdout.destroy(e))
      if (stdin instanceof Readable) stdin.pipe(channel)
      else channel.end(stdin ?? '')
      resolve({ stdout, done })
    })
  })
}

// ── Simulated engine for local development and tests ─────────────────────────
export type FakeClub = { kind?: 'app' | 'postgres'; registryUser?: string; project?: string; links?: string[]; predeploy?: string; password?: string; readOnly?: boolean; jobsPaused?: boolean; state: string; image: string; domains: string; db?: Buffer; files?: Map<string, Buffer>; secrets?: Record<string, string>; staged?: { db: Buffer; files: Map<string, Buffer>; secrets: Record<string, string> } }
const g = globalThis as unknown as { __fakeClubs?: Map<string, FakeClub>; __fakeFail?: Set<string>; __fakeCalls?: { args: string[]; stdin?: string }[] }
export const fakeClubs = () => (g.__fakeClubs ??= new Map())
/** Tests: make the next call of a command fail, e.g. fakeFailures().add('upgrade'). */
export const fakeFailures = () => (g.__fakeFail ??= new Set())
export const fakeCalls = () => (g.__fakeCalls ??= [])
const gm = globalThis as unknown as { __fakeMissing?: Set<string> }
/** Tests: images the simulated VM can't pull (restore-apply answers 3 until image-load). */
export const fakeMissingImages = () => (gm.__fakeMissing ??= new Set())

export const fakeRunner: Runner = async (_server, args, stdin, onOutput) => {
  const [cmd, name, a, b] = args
  const clubs = fakeClubs()
  fakeCalls().push({ args, stdin })
  const say = (s: string) => { onOutput?.(s + '\n'); return s + '\n' }
  let output = ''
  if (process.env.DEPLOYER_FAKE_ENGINE_DELAY) await new Promise((r) => setTimeout(r, Number(process.env.DEPLOYER_FAKE_ENGINE_DELAY)))
  if (fakeFailures().delete(cmd)) return { code: 1, output: say(`clubctl: simulated ${cmd} failure`) }
  switch (cmd) {
    case 'host':
      return { code: 0, output: JSON.stringify({ memTotal: 8 * 2 ** 30, memAvailable: (8 - 0.45 * clubs.size - 1.5) * 2 ** 30, diskTotal: 160 * 2 ** 30, diskAvailable: 140 * 2 ** 30, clubs: clubs.size, running: [...clubs.values()].filter((c) => c.state === 'running').length }) + '\n' }
    case 'status':
      return { code: 0, output: [...clubs.entries()].map(([n, c]) => JSON.stringify({ name: n, kind: c.kind ?? 'avrosphere', state: c.state, running: c.state === 'running', image: c.image, memory: c.state === 'running' ? '412MiB' : '', domains: c.domains })).join('\n') + '\n' }
    case 'create':
      if (clubs.has(name)) return { code: 1, output: say(`clubctl: site already exists: ${name}`) }
      output += say(`==> Creating database ${name.replace(/-/g, '_')}`) + say(`==> Pulling ${a}`) + say('==> Running migrations') + say(`==> Starting ${name}`) + say('==> Creating the first admin')
      clubs.set(name, { state: 'running', image: a, domains: b, db: Buffer.from(`fake database of ${name}\n`), files: new Map(), secrets: { PAYLOAD_SECRET: `secret${name.replace(/-/g, '')}` } })
      applyServiceLines(clubs.get(name)!, stdin)
      return { code: 0, output: output + say(`==> Created ${name} at https://${b.split(',')[0]}`) }
    case 'app-create': {
      if (clubs.has(name)) return { code: 1, output: say(`clubctl: site already exists: ${name}`) }
      const c: FakeClub = { state: 'running', image: a, domains: b === '-' ? '' : b, kind: 'app' }
      applyServiceLines(c, stdin)
      output += say(`==> Pulling ${a}`) + fakePin(c, a)
      if (c.predeploy) output += say(`==> Running the pre-deploy command: ${c.predeploy}`)
      output += say(`==> Starting ${name}${c.project ? ` on network proj-${c.project}` : ''}`)
      clubs.set(name, c)
      return { code: 0, output: output + say(c.domains ? `==> Created ${name} at https://${c.domains.split(',')[0]}` : `==> Created ${name} (no web address; inside its project only)`) }
    }
    case 'app-deploy': {
      const c = clubs.get(name)
      if (!c) return { code: 1, output: say(`clubctl: no such club: ${name}`) }
      applyServiceLines(c, stdin)
      if (c.predeploy && fakeFailures().delete('predeploy')) return { code: 1, output: say(`==> Running the pre-deploy command: ${c.predeploy}`) + say('!! The pre-deploy command failed; the running version stays') }
      c.image = a
      return { code: 0, output: say(`==> Pulling ${a}`) + fakePin(c, a) + (c.predeploy ? say(`==> Running the pre-deploy command: ${c.predeploy}`) : '') + say('==> Starting the new version') + say(`==> Deployed ${a} to ${name}`) }
    }
    case 'db-create': {
      if (clubs.has(name)) return { code: 1, output: say(`clubctl: site already exists: ${name}`) }
      const c: FakeClub = { state: 'running', image: a, domains: '', kind: 'postgres', password: `pw${name.replace(/-/g, '')}0001`, db: Buffer.from(`fake postgres ${name}\n`), files: new Map(), secrets: {} }
      applyServiceLines(c, stdin)
      clubs.set(name, c)
      return { code: 0, output: say(`==> Pulling ${a}`) + say(`==> Starting PostgreSQL ${name}${c.project ? ` on network proj-${c.project}` : ''}`) + say(`==> Created database ${name}`) }
    }
    case 'db-stats': {
      const c = clubs.get(name)
      if (!c) return { code: 1, output: say(`clubctl: no such club: ${name}`) }
      return { code: 0, output: JSON.stringify({ running: c.state === 'running', bytes: c.db?.length ?? 0, connections: 2, maxConnections: 42, readOnly: !!c.readOnly }) + '\n' }
    }
    case 'db-credentials': {
      const c = clubs.get(name)
      if (!c) return { code: 1, output: say(`clubctl: no such club: ${name}`) }
      const u = name.replace(/-/g, '_')
      return { code: 0, output: `DATABASE_URL=postgresql://${u}:${c.password}@${name}:5432/${u}\nPGHOST=${name}\nPGPORT=5432\nPGUSER=${u}\nPGPASSWORD=${c.password}\nPGDATABASE=${u}\n` }
    }
    case 'db-rotate': {
      const c = clubs.get(name)
      if (!c) return { code: 1, output: say(`clubctl: no such club: ${name}`) }
      c.password = `pw${Date.now().toString(36)}`
      return { code: 0, output: say(`==> New password for ${name}`) }
    }
    case 'db-readonly': {
      const c = clubs.get(name)
      if (!c) return { code: 1, output: say(`clubctl: no such club: ${name}`) }
      c.readOnly = a === 'on'
      return { code: 0, output: say(`==> ${name} is ${c.readOnly ? 'read-only' : 'writable'}`) }
    }
    case 'db-upgrade': {
      const c = clubs.get(name)
      if (!c) return { code: 1, output: say(`clubctl: no such club: ${name}`) }
      c.image = a
      return { code: 0, output: say(`==> Copying ${name}`) + say(`==> Starting ${a}`) + say('==> Loading the copy') + say(`==> ${name} now runs ${a}`) }
    }
    case 'project-set': {
      const c = clubs.get(name)
      if (!c) return { code: 1, output: say(`clubctl: no such club: ${name}`) }
      c.project = a
      return { code: 0, output: say(`==> ${name} is on network proj-${a}`) }
    }
    case 'configure': {
      const c = clubs.get(name)
      if (!c) return { code: 1, output: say(`clubctl: no such club: ${name}`) }
      if (a !== '-') c.domains = a
      applyServiceLines(c, stdin)
      return { code: 0, output: say(`==> Restarting ${name} with the new settings`) + say(`==> Configured ${name}`) }
    }
    case 'upgrade':
      if (!clubs.has(name)) return { code: 1, output: say(`clubctl: no such club: ${name}`) }
      if (clubs.get(name)!.kind === 'app') return { code: 1, output: say(`clubctl: ${name} is an app: use app-deploy`) }
      clubs.get(name)!.image = a
      return { code: 0, output: say(`==> Pulling ${a}`) + say('==> Backing up the database first') + say('==> Running migrations') + say(`==> Upgraded ${name} to ${a}`) }
    case 'pause':
    case 'resume':
      if (!clubs.has(name)) return { code: 1, output: say(`clubctl: no such club: ${name}`) }
      clubs.get(name)!.state = cmd === 'pause' ? 'paused' : 'running'
      return { code: 0, output: say(`==> ${cmd === 'pause' ? 'Paused' : 'Resumed'} ${name}`) }
    case 'backup':
      return { code: 0, output: say(`==> Backed up ${name}`) }
    case 'remove':
      clubs.delete(name)
      return { code: 0, output: say(`==> Removed ${name} (final backup kept)`) }
    case 'restore-abort':
      if (clubs.get(name)) delete clubs.get(name)!.staged
      return { code: 0, output: say(`==> Threw away the staged backup of ${name}`) }
    case 'restore-apply': {
      const c = clubs.get(name)
      if (!c?.staged) return { code: 1, output: say(`clubctl: nothing is staged for ${name}`) }
      if (fakeMissingImages().has(a)) return { code: 3, output: say(`clubctl: image missing: ${a}`) }
      c.db = c.staged.db; c.files = c.staged.files; c.secrets = { ...c.secrets, ...c.staged.secrets }; c.image = a
      if (b === 'copy') c.jobsPaused = true
      delete c.staged
      return { code: 0, output: say(`==> Restored ${name} (now on ${a}, ${c.state})`) }
    }
    case 'image-load':
      fakeMissingImages().clear()
      return { code: 0, output: say('==> Loaded the image') }
    case 'secrets': {
      const c = clubs.get(name)
      if (!c) return { code: 1, output: say(`clubctl: no such club: ${name}`) }
      return { code: 0, output: Object.entries(c.secrets ?? {}).map(([k, v]) => `${k}=${v}\n`).join('') }
    }
    case 'https': {
      const c = clubs.get(name)
      if (!c) return { code: 1, output: say(`clubctl: no such club: ${name}`) }
      return { code: 0, output: c.domains.split(',').map((d: string) => say(`${d}: has a certificate`)).join('') + say('Nothing to do') }
    }
    case 'logs':
      return { code: 0, output: `(simulated) ▲ Next.js 15\n   - Local: http://localhost:3000\n ✓ Ready\n` }
    default:
      return { code: 1, output: say(`clubctl: unknown command: ${cmd}`) }
  }
}

let fakePulls = 0
/** Images from a registry (not our own GitHub builds, not already a digest) are pinned to what was pulled, as clubctl does. */
function fakePin(c: FakeClub, image: string): string {
  if (image.includes('@sha256:') || /\/app-[a-z0-9-]+:[0-9a-f]{12}$/.test(image)) return ''
  const pinned = `${image.replace(/:[^:/]+$/, '')}@sha256:${crypto.createHash('sha256').update(`${image}#${++fakePulls}`).digest('hex')}`
  c.image = pinned
  return `${c.registryUser ? `==> Signing in to the registry as ${c.registryUser}\n` : ''}Pinned to ${pinned}\n`
}

/** The CLUBCTL_PROJECT / LINK / PREDEPLOY lines a simulated server keeps, like clubctl does. */
function applyServiceLines(c: FakeClub, stdin?: string) {
  if (!stdin) return
  const lines = stdin.split('\n')
  const value = (key: string) => lines.filter((l) => l.startsWith(`${key}=`)).map((l) => l.slice(key.length + 1))
  const project = value('CLUBCTL_PROJECT').pop()
  if (project) c.project = project
  const registryUser = value('CLUBCTL_REGISTRY_USER').pop()
  if (registryUser) c.registryUser = registryUser
  if (c.kind === 'app' && lines.some((l) => l.startsWith('CLUBCTL_PREDEPLOY_B64='))) {
    c.links = value('CLUBCTL_LINK')
    c.predeploy = Buffer.from(value('CLUBCTL_PREDEPLOY_B64').pop() ?? '', 'base64').toString('utf8')
  }
}

export const isFakeEngine = () => ['1', 'true', 'yes', 'on'].includes((process.env.DEPLOYER_FAKE_ENGINE || '').toLowerCase())
export const runner = (): Runner => (isFakeEngine() ? fakeRunner : sshRunner)
export const streamRunner = (): StreamRunner => (isFakeEngine() ? fakeStreamRunner : sshStreamRunner)

// ── Simulated data commands ──────────────────────────────────────────────────
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex')

async function readAll(stdin?: Readable | Buffer | string): Promise<Buffer> {
  if (stdin === undefined) return Buffer.alloc(0)
  if (typeof stdin === 'string') return Buffer.from(stdin)
  if (Buffer.isBuffer(stdin)) return stdin
  const parts: Buffer[] = []
  for await (const c of stdin) parts.push(Buffer.from(c))
  return Buffer.concat(parts)
}

/** Parses the frame format clubctl uses (see agent/clubctl). */
export function parseFrames(buf: Buffer): { kind: string; arg: string; path: string; body: Buffer }[] {
  const out: { kind: string; arg: string; path: string; body: Buffer }[] = []
  let at = 0
  for (;;) {
    const nl = buf.indexOf(10, at)
    if (nl < 0) throw new Error('the stream ended early')
    const line = buf.subarray(at, nl).toString('utf8')
    at = nl + 1
    if (line === 'E') return out
    const [kind, arg] = [line.slice(0, 1), line.slice(2).split(' ')[0]]
    const path = line.slice(2 + arg.length + 1)
    if (kind === 'C') { out.push({ kind, arg, path, body: Buffer.alloc(0) }); continue }
    const size = Number(arg)
    out.push({ kind, arg, path, body: buf.subarray(at, at + size) })
    at += size
  }
}

export const fakeStreamRunner: StreamRunner = async (_server, args, stdin, onStderr) => {
  const [cmd, name, a] = args
  const c = fakeClubs().get(name)
  fakeCalls().push({ args })
  const data = (b: Buffer | string, code = 0, stderr = '') => {
    if (stderr) onStderr?.(stderr)
    return { stdout: Readable.from([Buffer.from(b)]), done: Promise.resolve({ code, stderr }) }
  }
  const fail = (msg: string) => data('', 1, `clubctl: ${msg}\n`)
  if (fakeFailures().delete(cmd)) return fail(`simulated ${cmd} failure`)
  if (cmd === 'image-save') return data(Buffer.from(`fake image ${name}\n`))
  if (cmd === 'image-load') { await readAll(stdin); fakeMissingImages().clear(); return data('', 0, '==> Loaded the image\n') }
  if (!c) return fail(`no such club: ${name}`)
  switch (cmd) {
    case 'info':
      return data(JSON.stringify({ name, image: c.image, digest: `sha256:${sha(Buffer.from(c.image))}`, state: c.state }) + '\n')
    case 'dump':
      return data(c.db ?? Buffer.alloc(0))
    case 'files-index':
      return data([...(c.files ?? new Map()).entries()].map(([p, b]) => `${p}\t${b.length}\t${sha(b)}\n`).join(''))
    case 'files-pack': {
      const paths = (await readAll(stdin)).toString('utf8').split('\n').filter(Boolean)
      const parts: Buffer[] = []
      for (const p of paths) {
        const b = c.files?.get(p)
        if (!b) continue
        parts.push(Buffer.from(`F ${b.length} ${p}\n`), b)
      }
      parts.push(Buffer.from('E\n'))
      return data(Buffer.concat(parts))
    }
    case 'restore-stage': {
      const frames = parseFrames(await readAll(stdin))
      const have = new Map([...(c.files ?? new Map()).values()].map((b) => [sha(b), b]))
      const staged = { db: Buffer.alloc(0), files: new Map<string, Buffer>(), secrets: {} as Record<string, string> }
      for (const f of frames) {
        if (f.kind === 'D') staged.db = Buffer.from(f.body)
        else if (f.kind === 'S') for (const l of f.body.toString('utf8').split('\n').filter(Boolean)) staged.secrets[l.split('=')[0]] = l.slice(l.indexOf('=') + 1)
        else if (f.kind === 'F') staged.files.set(f.path, Buffer.from(f.body))
        else if (f.kind === 'C') { const b = have.get(f.arg); if (!b) return fail(`no local copy of ${f.path}`); staged.files.set(f.path, b) }
      }
      c.staged = staged
      return data('', 0, `==> Staged the backup for ${name}\n`)
    }
    default:
      return fail(`unknown command: ${cmd}`)
  }
}
