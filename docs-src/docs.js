// Lanternly docs: menu on phones, copy buttons, "On this page" highlight, search.
(() => {
  const body = document.body
  const btn = document.querySelector('.menu-btn')
  btn?.addEventListener('click', () => {
    const open = body.classList.toggle('nav-open')
    btn.setAttribute('aria-expanded', String(open))
  })
  document.addEventListener('click', (e) => {
    if (body.classList.contains('nav-open') && !e.target.closest('.side, .menu-btn')) {
      body.classList.remove('nav-open'); btn?.setAttribute('aria-expanded', 'false')
    }
  })

  // Copy buttons on code blocks
  document.querySelectorAll('.doc pre').forEach((pre) => {
    const b = document.createElement('button')
    b.type = 'button'; b.className = 'copy'; b.textContent = 'Copy'
    b.addEventListener('click', async () => {
      const text = (pre.querySelector('code') || pre).innerText.replace(/\n?Copy$/, '')
      try { await navigator.clipboard.writeText(text); b.textContent = 'Copied'; b.classList.add('done') } catch { b.textContent = 'Select and copy' }
      setTimeout(() => { b.textContent = 'Copy'; b.classList.remove('done') }, 1600)
    })
    pre.appendChild(b)
  })

  // Highlight the section in view
  const links = [...document.querySelectorAll('.toc a')]
  if (links.length && 'IntersectionObserver' in window) {
    const map = new Map(links.map((a) => [a.getAttribute('href').slice(1), a]))
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (en.isIntersecting) { links.forEach((l) => l.classList.remove('on')); map.get(en.target.id)?.classList.add('on') }
      })
    }, { rootMargin: '-80px 0px -70% 0px' })
    map.forEach((_, id) => { const h = document.getElementById(id); if (h) io.observe(h) })
  }

  // Search
  const q = document.getElementById('q')
  const box = document.getElementById('results')
  if (!q || !box) return
  let index = null
  let sel = -1
  const load = () => index || (index = fetch('search.json').then((r) => r.json()).catch(() => []))
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  const hl = (s, words) => { let out = esc(s); words.forEach((w) => { out = out.replace(new RegExp(`(${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig'), '<mark>$1</mark>') }); return out }
  const snippet = (t, w) => { const i = t.toLowerCase().indexOf(w); if (i < 0) return t.slice(0, 120); const s = Math.max(0, i - 50); return (s ? '…' : '') + t.slice(s, s + 140) + '…' }

  async function run() {
    const term = q.value.trim().toLowerCase()
    if (term.length < 2) { box.hidden = true; return }
    const words = term.split(/\s+/).filter(Boolean)
    const data = await load()
    const hits = []
    data.forEach((p) => {
      const pageText = (p.title + ' ' + p.intro).toLowerCase()
      if (words.every((w) => pageText.includes(w))) hits.push({ score: p.title.toLowerCase().includes(words[0]) ? 30 : 10, u: p.u, h: p.title, t: snippet(p.intro, words[0]) })
      p.s.forEach((s) => {
        const text = (s.h + ' ' + s.t).toLowerCase()
        if (!words.every((w) => text.includes(w) || p.title.toLowerCase().includes(w))) return
        const score = (s.h.toLowerCase().includes(words[0]) ? 20 : 0) + words.filter((w) => text.includes(w)).length
        hits.push({ score, u: `${p.u}#${s.id}`, h: `${p.title} › ${s.h}`, t: snippet(s.t, words[0]) })
      })
    })
    hits.sort((a, b) => b.score - a.score)
    sel = -1
    box.innerHTML = hits.length
      ? hits.slice(0, 10).map((h) => `<a href="${h.u}" role="option"><b>${hl(h.h, words)}</b><small>${hl(h.t, words)}</small></a>`).join('')
      : '<div class="none">Nothing found. Try another word.</div>'
    box.hidden = false
  }
  q.addEventListener('focus', load)
  q.addEventListener('input', run)
  q.addEventListener('keydown', (e) => {
    const items = [...box.querySelectorAll('a')]
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); if (!items.length) return
      sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
      items.forEach((a, i) => a.setAttribute('aria-selected', String(i === sel)))
      items[sel].scrollIntoView({ block: 'nearest' })
    } else if (e.key === 'Enter' && items.length) { e.preventDefault(); location.href = items[Math.max(sel, 0)].href }
    else if (e.key === 'Escape') { box.hidden = true; q.blur() }
  })
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== q && !/input|textarea/i.test(document.activeElement?.tagName || '')) { e.preventDefault(); q.focus() }
  })
  document.addEventListener('click', (e) => { if (!e.target.closest('.search')) box.hidden = true })
})()
