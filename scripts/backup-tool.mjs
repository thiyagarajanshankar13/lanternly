#!/usr/bin/env node
// Reads the deployer's backups straight from the bucket, without the deployer:
// for when the deployer itself is lost, or to hand someone a copy of a site.
//
//   BACKUP_KEY=<64 hex characters from Backups> \
//   BUCKET=avrosphere-backups REGION=ap-southeast-2 \
//   AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… \
//   node scripts/backup-tool.mjs list
//   node scripts/backup-tool.mjs fetch <site folder> <backup> <output folder>
//
// "list" prints every backup (site folder, backup, version, time). "fetch"
// writes manifest.json, settings.json (the site's keys + deployer settings),
// database.dump (load it with pg_restore --no-owner) and files/ (the site's
// data folder) into the output folder, checking every checksum.
// Instead of BUCKET, BACKUP_DIR=<folder> reads a practice-mode folder.
// Needs the deployer's node_modules (npm ci) for the S3 client.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const MAGIC = Buffer.from('AVB1')
const die = (msg) => { console.error(`backup-tool: ${msg}`); process.exit(1) }
const key = Buffer.from((process.env.BACKUP_KEY || '').replace(/\s+/g, ''), 'hex')
if (key.length !== 32) die('set BACKUP_KEY to the 64-character backup key')

function decrypt(data, what) {
  if (!data.subarray(0, 4).equals(MAGIC)) die(`${what}: not a deployer backup file`)
  const fp = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16)
  if (data.subarray(8, 16).toString('hex') !== fp) die(`${what}: made with a different backup key`)
  const prefix = data.subarray(4, 8)
  const out = []
  let at = 16, n = 0, ended = false
  while (at < data.length) {
    const len = data.readUInt32BE(at), last = data[at + 4] === 1
    const nonce = Buffer.alloc(12); prefix.copy(nonce); nonce.writeBigUInt64BE(BigInt(n), 4)
    const aad = Buffer.alloc(9); aad.writeBigUInt64BE(BigInt(n)); aad[8] = last ? 1 : 0
    const d = crypto.createDecipheriv('aes-256-gcm', key, nonce)
    d.setAAD(aad); d.setAuthTag(data.subarray(at + 5 + len, at + 5 + len + 16))
    try { out.push(d.update(data.subarray(at + 5, at + 5 + len)), d.final()) } catch { die(`${what}: damaged (a check failed)`) }
    at += 5 + len + 16; n++
    if (last) { ended = true; break }
  }
  if (!ended || at !== data.length) die(`${what}: cut short`)
  return Buffer.concat(out)
}

async function makeStore() {
  if (process.env.BACKUP_DIR) {
    const root = path.resolve(process.env.BACKUP_DIR)
    const walk = (d, acc = []) => { if (fs.existsSync(d)) for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); e.isDirectory() ? walk(f, acc) : acc.push(path.relative(root, f).split(path.sep).join('/')) } return acc }
    return { list: async (prefix) => walk(root).filter((k) => k.startsWith(prefix)), get: async (k) => fs.readFileSync(path.join(root, k)) }
  }
  if (!process.env.BUCKET) die('set BUCKET (and REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY), or BACKUP_DIR')
  const { S3Client, ListObjectsV2Command, GetObjectCommand } = await import('@aws-sdk/client-s3')
  const client = new S3Client({ region: process.env.REGION || 'ap-southeast-2', ...(process.env.ENDPOINT ? { endpoint: process.env.ENDPOINT, forcePathStyle: true } : {}) })
  const Bucket = process.env.BUCKET
  return {
    async list(prefix) {
      const keys = []; let ContinuationToken
      do {
        const page = await client.send(new ListObjectsV2Command({ Bucket, Prefix: prefix, ContinuationToken }))
        for (const o of page.Contents ?? []) keys.push(o.Key)
        ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined
      } while (ContinuationToken)
      return keys
    },
    async get(k) { const o = await client.send(new GetObjectCommand({ Bucket, Key: k })); return Buffer.from(await o.Body.transformToByteArray()) },
  }
}

const [cmd, site, ref, outDir] = process.argv.slice(2)
const store = await makeStore()
if (cmd === 'list') {
  const manifests = (await store.list('sites/')).filter((k) => k.endsWith('/manifest.json')).sort()
  for (const k of manifests) {
    const m = JSON.parse(decrypt(await store.get(k), k).toString('utf8'))
    console.log([m.ns, m.ref, m.kind, m.image, m.startedAt, `${m.files.length} files`].join('\t'))
  }
} else if (cmd === 'fetch') {
  if (!site || !ref || !outDir) die('usage: fetch <site folder> <backup> <output folder>')
  const prefix = `sites/${site}/${ref}/`
  const m = JSON.parse(decrypt(await store.get(`${prefix}manifest.json`), 'manifest').toString('utf8'))
  fs.mkdirSync(path.join(outDir, 'files'), { recursive: true })
  const check = (buf, size, sha, what) => { if (buf.length !== size || crypto.createHash('sha256').update(buf).digest('hex') !== sha) die(`${what} doesn't match its checksum`) }
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(m, null, 2))
  fs.writeFileSync(path.join(outDir, 'settings.json'), decrypt(await store.get(m.settings.key), 'settings'), { mode: 0o600 })
  const db = decrypt(await store.get(m.database.key), 'database')
  check(db, m.database.size, m.database.sha256, 'The database')
  fs.writeFileSync(path.join(outDir, 'database.dump'), db)
  for (const [p, sha, size] of m.files) {
    if (p.split('/').some((x) => x === '..' || x === '')) die(`unsafe path in the backup: ${p}`)
    const buf = decrypt(await store.get(`blobs/${m.ns}/${sha.slice(0, 2)}/${sha}`), p)
    check(buf, size, sha, p)
    fs.mkdirSync(path.dirname(path.join(outDir, 'files', p)), { recursive: true })
    fs.writeFileSync(path.join(outDir, 'files', p), buf)
  }
  console.log(`Wrote ${m.site} backup ${m.ref} (${m.image}): database + ${m.files.length} files into ${outDir}`)
  if (m.imageSaved) console.log(`The Avrosphere version is saved too: images/${m.imageDigest.replace(/^sha256:/, '')}.tar.gz (decrypt, then docker load)`)
} else {
  die('commands: list, fetch <site folder> <backup> <output folder>')
}
