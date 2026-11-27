import fs from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { currentAdmin } from '@/lib/auth'
import { canOperateSite, canSeeSite } from '@/lib/access'
import { audit } from '@/lib/audit'
import { getClub, getServer } from '@/lib/clubs'
import { streamRunner } from '@/lib/engine'
import { randomToken } from '@/lib/crypto'
import { enqueue, hasPendingOperation } from '@/lib/ops'
import { DUMP_MAGIC, MAX_UPLOAD_BYTES, uploadDir, uploadPathFor } from '@/lib/postgres/dumps'

export const dynamic = 'force-dynamic'

async function database(params: Promise<{ id: string }>) {
  const admin = await currentAdmin()
  if (!admin) return { error: Response.json({ error: 'Not signed in' }, { status: 401 }) }
  const club = getClub(Number((await params).id))
  const server = club ? getServer(club.serverId) : null
  // Dumps hold every row, so they are for people who may operate the database, not viewers.
  if (!club || !server || club.kind !== 'postgres' || !canSeeSite(admin, club.id) || !canOperateSite(admin, club.id)) {
    return { error: Response.json({ error: 'Not found' }, { status: 404 }) }
  }
  return { admin, club, server }
}

/** Downloads a pg_dump (custom format) of the database: load it with pg_restore. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const found = await database(params)
  if ('error' in found) return found.error
  const { admin, club, server } = found
  if (club.status !== 'running') return Response.json({ error: 'Resume the database first.' }, { status: 409 })
  const call = await streamRunner()(server, ['dump', club.name])
  await audit(admin, 'db-dump-downloaded', { club })
  void call.done.then((r) => { if (r.code !== 0) console.error(`[postgres] dump of ${club.name} failed: ${r.stderr.trim().split('\n').pop()}`) })
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')
  return new Response(Readable.toWeb(call.stdout) as ReadableStream, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${club.name}-${stamp}.dump"`,
      'Cache-Control': 'no-store',
    },
  })
}

/**
 * Uploads a pg_dump file (custom format) and queues loading it in place of
 * the database's data (a bucket backup is taken first when backups are set up).
 * ?confirm=<database name> is required.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const found = await database(params)
  if ('error' in found) return found.error
  const { admin, club } = found
  if (new URL(req.url).searchParams.get('confirm') !== club.name) return Response.json({ error: `Type ${club.name} to confirm.` }, { status: 400 })
  if (club.status !== 'running') return Response.json({ error: 'Resume the database first.' }, { status: 409 })
  if (hasPendingOperation(club.id)) return Response.json({ error: 'Wait for the current change to finish first.' }, { status: 409 })
  if (!req.body) return Response.json({ error: 'No file came.' }, { status: 400 })
  const declared = Number(req.headers.get('content-length') || 0)
  if (declared > MAX_UPLOAD_BYTES) return Response.json({ error: 'The dump is over 2 GB. Load it from the server instead.' }, { status: 413 })

  fs.mkdirSync(uploadDir(), { recursive: true, mode: 0o700 })
  const file = uploadPathFor(club, randomToken(12).toLowerCase().replace(/[^a-z0-9]/g, '').padEnd(12, '0'))
  let bytes = 0
  let head = Buffer.alloc(0)
  const counted = Readable.fromWeb(req.body as import('node:stream/web').ReadableStream).map((chunk: Buffer) => {
    bytes += chunk.length
    if (head.length < DUMP_MAGIC.length) head = Buffer.concat([head, chunk.subarray(0, DUMP_MAGIC.length)])
    if (bytes > MAX_UPLOAD_BYTES) throw new Error('too big')
    return chunk
  })
  try {
    await pipeline(counted, fs.createWriteStream(file, { mode: 0o600 }))
  } catch {
    fs.rmSync(file, { force: true })
    return Response.json({ error: bytes > MAX_UPLOAD_BYTES ? 'The dump is over 2 GB.' : 'The upload broke off. Try again.' }, { status: 400 })
  }
  if (!head.subarray(0, DUMP_MAGIC.length).equals(DUMP_MAGIC)) {
    fs.rmSync(file, { force: true })
    return Response.json({ error: 'That isn’t a pg_dump file in custom format. Make one with pg_dump -Fc.' }, { status: 400 })
  }
  const op = enqueue(club, 'restore', admin.email, { uploadPath: file })
  await audit(admin, 'db-dump-loaded', { club, detail: `${Math.round(bytes / 1024 / 1024)} MB` })
  return Response.json({ ok: true, operationId: op.id })
}
