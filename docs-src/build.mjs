// Builds the documentation pages in ../docs from the fragments in ./pages.
// Plain Node, no packages: `node docs-src/build.mjs`. The output is committed,
// so GitHub Pages serves it as it is (no build on GitHub).
//
// Each fragment starts with a comment:
//   <!-- title: Page title | desc: One sentence for search engines and the index -->
// and holds the page body as HTML. Every <h2> and <h3> gets an id (from its
// text, unless it has one) and the h2s make the "On this page" list.

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, '..', 'docs')
const REPO = 'https://github.com/avrotech-com-au/lanternly'

// The side menu, in reading order. slug = pages/<slug>.html → docs/<slug>.html
export const NAV = [
  { group: 'Get started', items: ['index', 'quick-start', 'install', 'concepts'] },
  { group: 'Run things', items: ['servers', 'github-apps', 'docker-images', 'postgres', 's3-storage', 'domains'] },
  { group: 'Keep it safe', items: ['backups', 'monitoring', 'people', 'security'] },
  { group: 'Configure', items: ['settings', 'plugins', 'aws', 'configuration'] },
  { group: 'Help', items: ['upgrading', 'troubleshooting', 'contributing'] },
]

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const strip = (s) => s.replace(/<\/(td|th|li|p|pre|h[1-6])>|<br\s*\/?>/g, ' ').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&rarr;/g, '→').replace(/&[a-z]+;/g, ' ')
const slugify = (s) => strip(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

function readPage(slug) {
  const raw = readFileSync(join(here, 'pages', `${slug}.html`), 'utf8')
  const m = raw.match(/^<!--\s*title:\s*(.+?)\s*\|\s*desc:\s*(.+?)\s*-->\s*/)
  if (!m) throw new Error(`${slug}: missing title/desc comment`)
  let body = raw.slice(m[0].length)
  const toc = []
  const used = new Set()
  body = body.replace(/<h([23])(\s[^>]*)?>([\s\S]*?)<\/h\1>/g, (all, level, attrs = '', inner) => {
    let id = (attrs.match(/id="([^"]+)"/) || [])[1]
    if (!id) {
      id = slugify(inner) || 'section'
      let n = 2
      while (used.has(id)) id = `${slugify(inner)}-${n++}`
      attrs = `${attrs} id="${id}"`
    }
    used.add(id)
    if (level === '2') toc.push({ id, text: strip(inner) })
    return `<h${level}${attrs}><a class="anchor" href="#${id}" aria-hidden="true" tabindex="-1">#</a>${inner}</h${level}>`
  })
  return { slug, title: m[1], desc: m[2], body, toc }
}

const MARK = `<svg width="28" height="28" viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="lfn" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fde68a"/><stop offset="0.45" stop-color="#fbbf24"/><stop offset="1" stop-color="#d97706"/></linearGradient></defs><path d="M26 12a6 6 0 0 1 12 0" fill="none" stroke="#fbbf24" stroke-width="3.5" stroke-linecap="round"/><rect x="19" y="12" width="26" height="6" rx="3" fill="#fbbf24"/><rect x="16.5" y="19.5" width="31" height="30" rx="9" fill="#1c1c20" stroke="#fbbf24" stroke-width="3"/><path d="M32 25c5 6 7 10 7 14a7 7 0 0 1-14 0c0-4 2-8 7-14z" fill="url(#lfn)"/><rect x="20" y="51" width="24" height="5" rx="2.5" fill="#fbbf24"/></svg>`

const pages = NAV.flatMap((g) => g.items.map((slug) => ({ ...readPage(slug), group: g.group })))
const bySlug = Object.fromEntries(pages.map((p) => [p.slug, p]))
const href = (slug) => (slug === 'index' ? './' : `${slug}.html`)
const navTitle = (p) => (p.slug === 'index' ? 'Introduction' : p.title)

function sidebar(current) {
  return NAV.map((g) => `<div class="nav-group"><p class="nav-head">${esc(g.group)}</p><ul>${g.items
    .map((s) => `<li><a href="${href(s)}"${s === current ? ' aria-current="page"' : ''}>${esc(navTitle(bySlug[s]))}</a></li>`)
    .join('')}</ul></div>`).join('')
}

function layout(p, i) {
  const prev = pages[i - 1]
  const next = pages[i + 1]
  const toc = p.toc.length > 1
    ? `<nav class="toc" aria-label="On this page"><p class="nav-head">On this page</p><ul>${p.toc.map((t) => `<li><a href="#${t.id}">${esc(t.text)}</a></li>`).join('')}</ul></nav>`
    : ''
  const fullTitle = p.slug === 'index' ? 'Lanternly documentation' : `${p.title} · Lanternly docs`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(fullTitle)}</title>
<meta name="description" content="${esc(p.desc)}">
<meta property="og:type" content="article">
<meta property="og:title" content="${esc(fullTitle)}">
<meta property="og:description" content="${esc(p.desc)}">
<meta name="theme-color" content="#0f0f11">
<link rel="icon" type="image/svg+xml" href="../favicon.svg">
<link rel="icon" type="image/png" sizes="32x32" href="../favicon-32.png">
<link rel="apple-touch-icon" href="../apple-touch-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&amp;family=Space+Grotesk:wght@500;600;700&amp;family=JetBrains+Mono:wght@400;500&amp;display=swap" rel="stylesheet">
<link rel="stylesheet" href="docs.css">
</head>
<body>
<a class="skip" href="#content">Skip to the page</a>
<header class="top">
<div class="top-in">
<button class="menu-btn" type="button" aria-controls="side" aria-expanded="false" aria-label="Menu"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg></button>
<a class="brand" href="../">${MARK}<span>Lanternly</span><span class="brand-docs">Docs</span></a>
<div class="search"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input id="q" type="search" placeholder="Search the docs" autocomplete="off" aria-label="Search the docs"><kbd>/</kbd><div id="results" class="results" role="listbox" hidden></div></div>
<nav class="top-links" aria-label="Site"><a href="../">Home</a><a href="${REPO}">GitHub</a></nav>
</div>
</header>
<div class="wrap">
<aside id="side" class="side"><nav aria-label="Documentation">${sidebar(p.slug)}</nav></aside>
<main id="content" class="content">
<p class="crumb">${esc(p.group)}</p>
<article class="doc">
<h1>${esc(p.slug === 'index' ? 'Lanternly documentation' : p.title)}</h1>
${p.body.trim()}
</article>
<nav class="pager" aria-label="Previous and next page">${prev ? `<a class="prev" href="${href(prev.slug)}"><span>Previous</span>${esc(navTitle(prev))}</a>` : '<span></span>'}${next ? `<a class="next" href="${href(next.slug)}"><span>Next</span>${esc(navTitle(next))}</a>` : '<span></span>'}</nav>
<p class="edit"><a href="${REPO}/blob/gh-pages/docs-src/pages/${p.slug}.html">Edit this page on GitHub</a></p>
<footer class="foot"><span>Lanternly · AGPL-3.0</span><a href="${REPO}">GitHub</a><a href="${REPO}/blob/main/SECURITY.md">Security policy</a><a href="${REPO}/blob/main/CONTRIBUTING.md">Contributing</a></footer>
</main>
${toc}
</div>
<script src="docs.js" defer></script>
</body>
</html>
`
}

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
pages.forEach((p, i) => writeFileSync(join(out, `${p.slug}.html`), layout(p, i)))

// Search index: page title, its headings and plain text (trimmed).
const index = pages.map((p) => {
  const sections = []
  const re = /<h([23]) id="([^"]+)"[^>]*>([\s\S]*?)<\/h\1>([\s\S]*?)(?=<h[23] |$)/g
  let m
  while ((m = re.exec(p.body))) sections.push({ id: m[2], h: strip(m[3]).replace(/^#/, '').trim(), t: strip(m[4]).replace(/\s+/g, ' ').trim().slice(0, 600) })
  const intro = strip(p.body.split(/<h2 /)[0]).replace(/\s+/g, ' ').trim().slice(0, 400)
  return { u: href(p.slug), title: navTitle(p), intro, s: sections }
})
writeFileSync(join(out, 'search.json'), JSON.stringify(index))
for (const f of ['docs.css', 'docs.js']) writeFileSync(join(out, f), readFileSync(join(here, f)))
console.log(`Built ${pages.length} pages into docs/`)
