import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/lib/db'
import {
  addWatched, alertRecipients, fetchStats, listStatsDays, recordStats, refreshStats, setStatsKey, certLevel, checkSite, checkUrl, cleanSiteUrl, daysLeft, getWatched, isBehind, latestVersion, listChecks, recordCert, recordCheck,
  removeWatched, runDueChecks, setAlertSenderForTests, updateWatched, uptime, type Alert,
} from '@/lib/monitor'
import { createAdmin } from '@/lib/auth'
import { saveSettings } from '@/lib/settings'
import { clubStatsKey } from '@/lib/statsKey'
import { freshEnv } from './setup'

freshEnv()

// A stand-in site whose behaviour each test sets.
let mode: 'avrosphere' | 'plain' | 'broken' | 'unwell' = 'avrosphere'
let server: http.Server
let origin = ''
const alerts: Alert[] = []
const STATS_KEY = 'a-long-stats-key-0123456789'
let numbers = { members: 120, staff: 4, membersActive: 61, membersNew: 9 }
let statsCalls = 0

beforeAll(async () => {
  process.env.DEPLOYER_MONITOR_ALLOW_PRIVATE = '1'
  server = http.createServer((req, res) => {
    if (mode === 'broken') { res.writeHead(502); res.end('bad gateway'); return }
    if (req.url === '/api/health') {
      if (mode === 'plain') { res.writeHead(404); res.end('not found'); return }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: mode !== 'unwell', app: 'avrosphere', version: '1.1.0', commit: 'abcdef1234567' }))
      return
    }
    if (req.url === '/api/health/stats') {
      statsCalls++
      if (mode === 'plain') { res.writeHead(404); res.end('not found'); return }
      if (req.headers.authorization !== `Bearer ${STATS_KEY}`) { res.writeHead(401); res.end('{}'); return }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, ...numbers, windowDays: 30 }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<h1>Home</h1>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  setAlertSenderForTests((alert) => { alerts.push(alert) })
})
afterAll(() => { setAlertSenderForTests(undefined); server.close() })
beforeEach(() => { mode = 'avrosphere'; alerts.length = 0; db().exec('DELETE FROM watched_sites') })

describe('web addresses', () => {
  it('tidies what people type', () => {
    expect(cleanSiteUrl('www.Example.com/about?x=1')).toBe('https://www.example.com')
    expect(cleanSiteUrl(' http://example.com:8080/ ')).toBe('http://example.com:8080')
    expect(cleanSiteUrl('ftp://example.com')).toBeNull()
    expect(cleanSiteUrl('https://user:pw@example.com')).toBeNull()
    expect(cleanSiteUrl('just-a-word')).toBeNull()
    expect(cleanSiteUrl('')).toBeNull()
  })
  it('refuses private addresses unless allowed', async () => {
    delete process.env.DEPLOYER_MONITOR_ALLOW_PRIVATE
    const r = await checkUrl(origin)
    process.env.DEPLOYER_MONITOR_ALLOW_PRIVATE = '1'
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/private network/)
  })
})

describe('one check', () => {
  it('reads the version from /api/health', async () => {
    const r = await checkUrl(origin)
    expect(r).toMatchObject({ ok: true, hasHealth: true, version: '1.1.0', commit: 'abcdef1234567', error: '' })
    expect(r.ms).toBeGreaterThanOrEqual(0)
  })
  it('falls back to the home page when there is no health endpoint', async () => {
    mode = 'plain'
    expect(await checkUrl(origin)).toMatchObject({ ok: true, hasHealth: false, version: '' })
  })
  it('fails on a server error, an unwell site and a dead address', async () => {
    mode = 'broken'
    expect((await checkUrl(origin)).error).toMatch(/502/)
    mode = 'unwell'
    expect(await checkUrl(origin)).toMatchObject({ ok: false, hasHealth: true })
    const spare = http.createServer()
    await new Promise<void>((resolve) => spare.listen(0, '127.0.0.1', resolve))
    const port = (spare.address() as AddressInfo).port
    await new Promise((resolve) => spare.close(resolve))
    const dead = await checkUrl(`http://127.0.0.1:${port}`)
    expect(dead.ok).toBe(false)
    expect(dead.error).toMatch(/refused/)
  })
})

describe('up, down and alerts', () => {
  it('needs two failed checks before a site is down, alerts once, and again when it is back', async () => {
    const site = addWatched('Riverside', origin)
    await checkSite(site.id)
    expect(getWatched(site.id)).toMatchObject({ status: 'up', version: '1.1.0', fails: 0 })
    expect(alerts).toHaveLength(0)

    mode = 'broken'
    await checkSite(site.id)
    expect(getWatched(site.id)).toMatchObject({ status: 'up', fails: 1 })
    expect(alerts).toHaveLength(0)
    await checkSite(site.id)
    await checkSite(site.id)
    expect(getWatched(site.id)).toMatchObject({ status: 'down', fails: 3, version: '1.1.0' })
    expect(alerts.map((a) => a.kind)).toEqual(['down'])
    expect(alerts[0].subject).toBe('Down: Riverside')

    mode = 'avrosphere'
    await checkSite(site.id)
    expect(getWatched(site.id)).toMatchObject({ status: 'up', fails: 0, lastError: '' })
    expect(alerts.map((a) => a.kind)).toEqual(['down', 'up'])
    expect(listChecks(site.id).map((c) => c.ok)).toEqual([true, false, false, false, true])
  })

  it('a first-ever failure does not alert until the second', async () => {
    mode = 'broken'
    const site = addWatched('New', origin)
    await checkSite(site.id)
    expect(getWatched(site.id)).toMatchObject({ status: 'unknown', fails: 1 })
    await checkSite(site.id)
    expect(getWatched(site.id)!.status).toBe('down')
    expect(alerts).toHaveLength(1)
  })

  it('works out uptime and usual speed', async () => {
    const site = addWatched('Stats', origin)
    const at = Date.now()
    const ok = { ok: true, ms: 100, error: '', hasHealth: true, version: '1.1.0', commit: '' }
    const bad = { ok: false, ms: null, error: 'x', hasHealth: false, version: '', commit: '' }
    await recordCheck(site.id, ok, new Date(at - 3 * 3600_000).toISOString())
    await recordCheck(site.id, { ...ok, ms: 300 }, new Date(at - 2 * 3600_000).toISOString())
    await recordCheck(site.id, bad, new Date(at - 3600_000).toISOString())
    await recordCheck(site.id, ok, new Date(at - 30 * 3600_000).toISOString())
    expect(uptime(site.id, 24, at)).toEqual({ percent: 66.7, checks: 3, avgMs: 200 })
    expect(uptime(site.id, 48, at).checks).toBe(4)
    expect(uptime(999, 24).percent).toBeNull()
  })

  it('checks every due site in one pass, skips paused ones, and waits for the next turn', async () => {
    const a = addWatched('A', origin)
    const b = addWatched('B', `${origin.replace('127.0.0.1', 'localhost')}`)
    updateWatched(b.id, { paused: true })
    expect(await runDueChecks()).toBe(1)
    expect(getWatched(a.id)!.status).toBe('up')
    expect(getWatched(b.id)!.status).toBe('unknown')
    expect(await runDueChecks()).toBe(0)
    expect(await runDueChecks({ force: true })).toBe(1)
  })

  it('a changed address starts from scratch; removing drops the history', async () => {
    const site = addWatched('Move', origin)
    await checkSite(site.id)
    updateWatched(site.id, { url: 'https://elsewhere.example' })
    expect(getWatched(site.id)).toMatchObject({ status: 'unknown', version: '', lastCheckedAt: null })
    removeWatched(site.id)
    expect(getWatched(site.id)).toBeNull()
    expect(listChecks(site.id)).toHaveLength(0)
  })
})

describe('user numbers', () => {
  it('reads counts with the saved key, once an hour, and keeps one row per day', async () => {
    const site = addWatched('Numbers', origin)
    await checkSite(site.id)
    expect(getWatched(site.id)).toMatchObject({ members: null, hasStatsKey: false })
    setStatsKey(site.id, STATS_KEY)
    statsCalls = 0
    await checkSite(site.id)
    await checkSite(site.id)
    expect(statsCalls).toBe(1)
    expect(getWatched(site.id)).toMatchObject({ members: 120, staff: 4, membersActive: 61, membersNew: 9, statsError: '', hasStatsKey: true })
    numbers = { ...numbers, members: 125 }
    await checkSite(site.id, { stats: true })
    expect(listStatsDays(site.id)).toHaveLength(1)
    expect(listStatsDays(site.id)[0].members).toBe(125)
    recordStats(site.id, { numbers: { members: 110, staff: 4, membersActive: 50, membersNew: 3 }, error: '' }, '2026-11-01T03:00:00.000Z')
    expect(listStatsDays(site.id).map((d) => d.day)).toEqual([new Date().toISOString().slice(0, 10), '2026-11-01'])
    expect(JSON.stringify(db().prepare('SELECT stats_key_enc FROM watched_sites WHERE id = ?').get(site.id))).not.toContain(STATS_KEY)
  })
  it('explains a wrong key and a site that has no numbers, keeping the last ones seen', async () => {
    expect((await fetchStats(origin, 'the-wrong-key-0123456789')).error).toMatch(/doesn't match/)
    mode = 'plain'
    expect((await fetchStats(origin, STATS_KEY)).error).toMatch(/version that reports user numbers/)
    expect(await fetchStats(origin, '')).toEqual({ numbers: null, error: '' })
    mode = 'avrosphere'
    const site = addWatched('Keeps', origin)
    setStatsKey(site.id, STATS_KEY)
    await refreshStats(site.id)
    setStatsKey(site.id, 'the-wrong-key-0123456789')
    db().prepare('UPDATE watched_sites SET members = 7 WHERE id = ?').run(site.id)
    await refreshStats(site.id)
    expect(getWatched(site.id)).toMatchObject({ members: 7 })
    expect(getWatched(site.id)!.statsError).toMatch(/doesn't match/)
    setStatsKey(site.id, '')
    expect(getWatched(site.id)).toMatchObject({ members: null, hasStatsKey: false })
  })
  it('never sends the key over plain http outside tests', async () => {
    delete process.env.DEPLOYER_MONITOR_ALLOW_PRIVATE
    const r = await fetchStats('http://example.com', STATS_KEY)
    process.env.DEPLOYER_MONITOR_ALLOW_PRIVATE = '1'
    expect(r.error).toMatch(/HTTPS/)
  })
  it("a deployer site's key is derived, stable and different per site", () => {
    expect(clubStatsKey('harbour')).toBe(clubStatsKey('harbour'))
    expect(clubStatsKey('harbour')).not.toBe(clubStatsKey('northside'))
    expect(clubStatsKey('harbour').length).toBeGreaterThanOrEqual(32)
  })
})

describe('certificates', () => {
  it('levels: fine, two weeks, three days', () => {
    expect(certLevel(null)).toBe(0)
    expect(certLevel(60)).toBe(0)
    expect(certLevel(14)).toBe(14)
    expect(certLevel(4)).toBe(14)
    expect(certLevel(3)).toBe(3)
    expect(certLevel(-2)).toBe(3)
    expect(daysLeft('2026-12-01T00:00:00Z', Date.parse('2026-11-21T12:00:00Z'))).toBe(9)
  })
  it('warns once at 14 days, once more at 3, and starts over after a renewal', async () => {
    const site = addWatched('Cert', 'https://cert.example')
    const today = '2026-11-22T00:00:00.000Z'
    const inDays = (n: number) => new Date(Date.parse(today) + n * 86_400_000 + 3600_000).toISOString()
    await recordCert(site.id, inDays(40), today)
    expect(alerts).toHaveLength(0)
    await recordCert(site.id, inDays(13), today)
    await recordCert(site.id, inDays(12), today)
    expect(alerts.map((a) => a.kind)).toEqual(['cert'])
    await recordCert(site.id, inDays(2), today)
    await recordCert(site.id, inDays(1), today)
    expect(alerts).toHaveLength(2)
    expect(alerts[1].subject).toMatch(/expires in 2 days/)
    await recordCert(site.id, inDays(89), today)
    expect(getWatched(site.id)!.certAlertLevel).toBe(0)
    await recordCert(site.id, inDays(10), today)
    expect(alerts).toHaveLength(3)
  })
})

describe('who and what', () => {
  it('alerts go to the typed addresses, else every admin', () => {
    createAdmin('ops@example.com', 'Ops', 'a-long-password-1')
    expect(alertRecipients()).toEqual(['ops@example.com'])
    saveSettings({ alertEmails: 'A@Example.com, not-an-email; b@example.com' })
    expect(alertRecipients()).toEqual(['a@example.com', 'b@example.com'])
  })
  it('knows when a site is behind the newest version', async () => {
    expect(isBehind('1.1.0', '1.2.0')).toBe(true)
    expect(isBehind('1.2.0', '1.2.0')).toBe(false)
    expect(isBehind('1.3.0-beta.abc', '1.2.0')).toBe(false)
    expect(isBehind('1.1.0', '1.1.0-beta.db926184fa')).toBe(false)
    expect(isBehind('', '1.2.0')).toBe(false)
    expect(isBehind('1.1.0', '')).toBe(false)
    // No plugin that knows releases: nothing to compare with.
    saveSettings({ plugins: '' })
    expect(await latestVersion()).toBe('')
    // The Avrosphere plugin's newest release wins over the deployer's current version (here a beta of an older one).
    saveSettings({ plugins: 'avrosphere', defaultImage: 'ghcr.io/avrotech-com-au/avrosphere-shared:1.1.0-beta.db926184fa' })
  })
})
