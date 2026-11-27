#!/usr/bin/env node
// Makes the public copy of the deployer: the core and the plugins we publish,
// without the private ones (export/manifest.json says which) and without
// Avrotech's own files. Nothing here changes this repo.
//
//   node scripts/export-core.mjs --out ../deployer-public          files only
//   node scripts/export-core.mjs --out ../deployer-public --git    plus a fresh git repo with one commit
//   node scripts/export-core.mjs --out ../deployer-public --check  plus npm ci, type check, tests and build
//
// It copies the files git tracks (as they are in the working tree), so make
// sure everything you mean to publish is committed. Afterwards it lists every
// place the copy still mentions a word from manifest.flag, for a person to read.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const args = process.argv.slice(2)
const outArg = args[args.indexOf('--out') + 1]
if (!args.includes('--out') || !outArg) {
  console.error('Usage: node scripts/export-core.mjs --out <folder> [--git] [--check]')
  process.exit(2)
}
const OUT = path.resolve(outArg)
if (OUT === ROOT || OUT.startsWith(ROOT + path.sep)) { console.error('The copy has to go outside this repo.'); process.exit(2) }
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'export/manifest.json'), 'utf8'))
const drop = manifest.dropPlugins

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const tag = new RegExp(`plugin:(${drop.map(escape).join('|')})\\b(?!:)`)
const blockStart = new RegExp(`plugin:(${drop.map(escape).join('|')}):start\\b`)
const blockEnd = new RegExp(`plugin:(${drop.map(escape).join('|')}):end\\b`)

const excluded = [
  ...manifest.exclude,
  ...drop.flatMap((id) => [`src/plugins/${id}/`, `tests/plugins/${id}/`, `agent/kinds/${id}.sh`]),
  ...Object.keys(manifest.replace),
]
const isExcluded = (file) => excluded.some((e) => (e.endsWith('/') ? file.startsWith(e) : file === e))

const TEXT = /\.(ts|tsx|js|mjs|cjs|json|md|css|yml|yaml|sh|html|txt|example|conf)$|(^|\/)(Dockerfile|Caddyfile|clubctl|clubctl-ssh|\.gitignore|\.dockerignore|\.env\.example)$/

/** Drops tagged lines and blocks; returns null when the whole file belongs to a dropped plugin. */
export function strip(text) {
  const lines = text.split('\n')
  if (tag.test(lines[0] ?? '')) return null
  const kept = []
  let inBlock = false
  for (const line of lines) {
    if (blockStart.test(line)) { inBlock = true; continue }
    if (blockEnd.test(line)) { inBlock = false; continue }
    if (inBlock || tag.test(line)) continue
    kept.push(line)
  }
  if (inBlock) throw new Error('A plugin block has a start but no end')
  return kept.join('\n')
}

fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })

const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT }).toString().split('\0').filter(Boolean)
let copied = 0, dropped = 0
for (const file of files) {
  const from = path.join(ROOT, file)
  if (!fs.existsSync(from)) continue
  if (isExcluded(file)) { dropped++; continue }
  const to = path.join(OUT, file)
  fs.mkdirSync(path.dirname(to), { recursive: true })
  if (TEXT.test(file)) {
    const body = strip(fs.readFileSync(from, 'utf8'))
    if (body === null) { dropped++; continue }
    fs.writeFileSync(to, body)
  } else {
    fs.copyFileSync(from, to)
  }
  fs.chmodSync(to, fs.statSync(from).mode)
  copied++
}
for (const [to, from] of Object.entries(manifest.replace)) {
  fs.mkdirSync(path.dirname(path.join(OUT, to)), { recursive: true })
  fs.copyFileSync(path.join(ROOT, from), path.join(OUT, to))
}
// package.json: the public name and description; the lock file follows.
const pkg = JSON.parse(fs.readFileSync(path.join(OUT, 'package.json'), 'utf8'))
Object.assign(pkg, manifest.packageJson, { license: 'AGPL-3.0-only' })
fs.writeFileSync(path.join(OUT, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
const lock = JSON.parse(fs.readFileSync(path.join(OUT, 'package-lock.json'), 'utf8'))
lock.name = pkg.name
if (lock.packages?.['']) Object.assign(lock.packages[''], { name: pkg.name, license: pkg.license })
fs.writeFileSync(path.join(OUT, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n')

console.log(`Copied ${copied} files to ${OUT}; left out ${dropped}.`)

// Words worth a second look (Avrotech names, our hosts). Not an error: some are
// deliberate (the default server folder /opt/avrosphere keeps live servers working).
const hits = []
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === '.next') continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else if (TEXT.test(e.name) || TEXT.test(path.relative(OUT, p))) {
      fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
        const word = manifest.flag.find((w) => line.toLowerCase().includes(w.toLowerCase()))
        if (word) hits.push(`${path.relative(OUT, p)}:${i + 1}: [${word}] ${line.trim().slice(0, 140)}`)
      })
    }
  }
}
walk(OUT)
fs.writeFileSync(path.join(path.dirname(OUT), `${path.basename(OUT)}-flagged.txt`), hits.join('\n') + '\n')
console.log(`${hits.length} lines mention a flagged word: see ${path.basename(OUT)}-flagged.txt beside the copy.`)

const run = (cmd, cmdArgs, opts = {}) => execFileSync(cmd, cmdArgs, { cwd: OUT, stdio: 'inherit', ...opts })
if (args.includes('--check')) {
  run('npm', ['ci', '--no-audit', '--no-fund'])
  run('npx', ['tsc', '--noEmit'])
  run('npx', ['vitest', 'run'])
  run('npx', ['next', 'build'])
}
if (args.includes('--git')) {
  run('git', ['init', '-q', '-b', 'main'])
  run('git', ['add', '-A'])
  run('git', ['-c', 'user.name=Deployer', '-c', 'user.email=deployer@example.com', 'commit', '-q', '-m', 'Initial public release'])
  console.log('Made a fresh git repo with one commit. Set the author before pushing if you want another one.')
}
