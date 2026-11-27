import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { Club } from '../clubs'
import { dataDir } from '../db'
import { runner, streamRunner, type ServerRow } from '../engine'

// Getting data in and out of a database service without opening it to the
// internet: a dump (pg_dump custom format) downloaded through the deployer,
// and a dump uploaded through the deployer and loaded on the server.

/** The largest dump the deployer takes as an upload. */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024
/** Every custom-format pg_dump file starts with these bytes. */
export const DUMP_MAGIC = Buffer.from('PGDMP')

export const uploadDir = () => path.join(dataDir(), 'db-uploads')
/** Where an upload for one database waits until its "Load" operation runs. */
export function uploadPathFor(club: Pick<Club, 'id'>, token: string): string {
  if (!/^[a-z0-9]{8,40}$/.test(token)) throw new Error('bad upload token')
  return path.join(uploadDir(), `${club.id}-${token}.dump`)
}

/** Streams the dump to the server, which loads it beside the live data and then swaps it in. */
export async function loadDump(server: ServerRow, club: Club, file: string, out: (chunk: string) => void): Promise<boolean> {
  if (!file.startsWith(uploadDir() + path.sep) || !fs.existsSync(file)) { out('The uploaded file is gone; upload it again.\n'); return false }
  const size = fs.statSync(file).size
  out(`==> Sending the dump (${Math.round(size / 1024 / 1024)} MB) to the server\n`)
  async function* frames() {
    yield Buffer.from(`D ${size}\n`)
    for await (const chunk of fs.createReadStream(file)) yield chunk as Buffer
    yield Buffer.from('E\n')
  }
  try {
    const staging = await streamRunner()(server, ['restore-stage', club.name], Readable.from(frames()), out)
    for await (const _ of staging.stdout) { /* drain */ }
    const staged = await staging.done
    if (staged.code !== 0) {
      await runner()(server, ['restore-abort', club.name], undefined, out).catch(() => undefined)
      out("!! The dump didn't load (see above). The database was not changed.\n")
      return false
    }
    const applied = await runner()(server, ['restore-apply', club.name, club.image], undefined, out)
    return applied.code === 0
  } finally {
    fs.rmSync(file, { force: true })
  }
}
