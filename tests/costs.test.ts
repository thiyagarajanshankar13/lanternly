import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeCostSource, costRanges, setCostSourceForTests, type LightsailResource } from '@/plugins/aws/costs/aws'
import { allocate, creditSummary, creditsUsedSince, dueAlerts, isSpike, lightsailPart, parseAlertState, summarise, type Snapshot } from '@/plugins/aws/costs/report'
import { fetchDue, lastAttempt, latestSnapshot, refreshCosts, setCostAlertSenderForTests, setRateFetcherForTests } from '@/plugins/aws/costs/service'
import { getSettings, saveSettings } from '@/lib/settings'
import { freshEnv } from './setup'

const TODAY = new Date('2026-11-24T03:00:00Z')

async function snapshot(opts: ConstructorParameters<typeof FakeCostSource>[0] = {}, rate = 1.5): Promise<Snapshot> {
  const src = new FakeCostSource(opts)
  return { fetchedAt: TODAY.toISOString(), raw: await src.costs(TODAY), resources: await src.resources(), rate: rate, rateSource: 'typed', rateDate: '', credits: await src.credits() }
}
const noTyped = { usd: 0, asOf: '', expires: '' }

describe('ranges', () => {
  it('asks for whole months and 31 days, end dates exclusive', () => {
    const r = costRanges(TODAY)
    expect(r.monthly).toEqual({ Start: '2026-05-01', End: '2026-11-25' })
    expect(r.daily).toEqual({ Start: '2026-10-25', End: '2026-11-25' })
    expect(r.lightsail.Start).toBe('2026-10-01')
    expect(r.forecast).toEqual({ Start: '2026-11-25', End: '2026-12-01' })
  })
})

describe('summary in A$', () => {
  it('converts every amount and forecasts from AWS', async () => {
    const snap = await snapshot({ dailyUsd: 2 }, 1.5)
    const sum = summarise(snap, TODAY)
    expect(sum.month).toBe('2026-11')
    expect(sum.monthToDate).toBeCloseTo(snap.raw.monthly.at(-1)!.total * 1.5, 1)
    expect(sum.forecast).toBeCloseTo(sum.monthToDate + snap.raw.forecastRest! * 1.5, 1)
    expect(sum.lastMonth).toBeCloseTo(2 * 31 * 1.5, 1)
    expect(sum.daily).toHaveLength(31)
    expect(sum.services[0].name).toBe('Amazon Lightsail')
    expect(sum.lightsail.map((l) => l.name)).toEqual(expect.arrayContaining(['VMs', 'Bucket (backups)', 'Data transfer']))
    expect(sum.lastDay?.day).toBe('2026-11-23')
  })
  it('estimates in a straight line when AWS has no forecast', async () => {
    const snap = await snapshot()
    snap.raw.forecastRest = null
    const sum = summarise(snap, TODAY)
    expect(sum.forecastFrom).toBe('estimate')
    expect(sum.forecast).toBeGreaterThan(sum.monthToDate)
  })
  it('sorts Lightsail usage types into parts', () => {
    expect(lightsailPart('APS2-BundleUsage:8GB')).toBe('VMs')
    expect(lightsailPart('APS2-BucketBundleUsage:100GB')).toBe('Bucket (backups)')
    expect(lightsailPart('APS2-DataXfer-Out-Bytes')).toBe('Data transfer')
    expect(lightsailPart('APS2-StaticIP-Unattached')).toBe('Static IPs')
    expect(lightsailPart('APS2-Snapshot-Usage')).toBe('Snapshots')
  })
})

describe('per-site estimate', () => {
  const res: LightsailResource[] = [
    { kind: 'instance', name: 'sites', plan: '8 GB', monthlyUsd: 40, publicIp: '1.1.1.1', privateIp: '10.0.0.1', state: 'running' },
    { kind: 'instance', name: 'deployer', plan: '2 GB', monthlyUsd: 10, publicIp: '2.2.2.2', privateIp: '', state: 'running' },
    { kind: 'bucket', name: 'b', plan: '100 GB', monthlyUsd: 3, publicIp: '', privateIp: '', state: 'OK' },
  ]
  const servers = [{ id: 1, name: 'sites-1', host: '10.0.0.1', publicIp: '1.1.1.1' }, { id: 2, name: 'old', host: '9.9.9.9', publicIp: '9.9.9.9' }]
  it('splits the VM by memory, the bucket by size and the deployer evenly', () => {
    const a = allocate([
      { id: 1, name: 'a', displayName: 'A', serverId: 1, memoryMb: 600, running: true, bucketBytes: 300 },
      { id: 2, name: 'b', displayName: 'B', serverId: 1, memoryMb: 200, running: true, bucketBytes: 100 },
      { id: 3, name: 'c', displayName: 'C', serverId: 1, memoryMb: 700, running: false, bucketBytes: 0 },
    ], servers, res, 1.5)
    const by = Object.fromEntries(a.sites.map((s) => [s.name, s]))
    expect(by.a.vm).toBe(45); expect(by.b.vm).toBe(15); expect(by.c.vm).toBe(0)
    expect(by.a.bucket).toBe(3.38); expect(by.b.bucket).toBe(1.13)
    expect(by.a.shared).toBe(7.5); expect(by.c.shared).toBe(0)
    expect(a.sharedVms.map((v) => v.name)).toEqual(['deployer'])
    expect(a.planTotal).toBe(79.5)
    expect(a.unmatched).toEqual([])
  })
  it('flags a server with sites but no VM', () => {
    const a = allocate([{ id: 1, name: 'a', displayName: 'A', serverId: 2, memoryMb: 600, running: true, bucketBytes: 0 }], servers, res, 1)
    expect(a.unmatched.map((s) => s.name)).toEqual(['old'])
    expect(a.sites[0].vm).toBe(0)
  })
})

describe('credits', () => {
  it('splits each month into charges, credits and what is paid, in A$', async () => {
    const snap = await snapshot({ dailyUsd: 2, creditShare: 0.5 }, 1.5)
    const c = creditSummary(snap, TODAY, noTyped)
    const sum = summarise(snap, TODAY)
    expect(c.thisMonth.pay).toBeCloseTo(sum.monthToDate, 1)
    expect(c.thisMonth.credits).toBeCloseTo(sum.monthToDate * 0.5, 0)
    expect(c.thisMonth.charges).toBeCloseTo(c.thisMonth.pay + c.thisMonth.credits, 1)
    expect(c.lastMonth.pay).toBeCloseTo(2 * 31 * 1.5, 1)
    expect(c.chargesForecast).toBeGreaterThan(sum.forecast)
    expect(c.months).toHaveLength(7)
    expect(c.none).toBe(false)
  })
  it('reads credits left from the AWS free plan, with a run-out date', async () => {
    const snap = await snapshot({ dailyUsd: 2, creditShare: 1, planCreditsUsd: 20 }, 1.5)
    const c = creditSummary(snap, TODAY, noTyped)
    expect(c).toMatchObject({ left: 30, leftFrom: 'aws free plan', runsOutWhy: 'used up' })
    expect(c.usePerDay).toBeCloseTo(3, 1) // US$2 a day of credits at 1.5
    expect(c.runsOut).toBe('2026-12-04') // 20 / 2 = 10 days
  })
  it('takes credits used since a typed balance off it, and stops at the expiry date', async () => {
    const snap = await snapshot({ dailyUsd: 2, creditShare: 1 }, 1)
    expect(creditsUsedSince(snap.raw, '2026-11-20')).toBeCloseTo(2 * 4 + 0.8, 1) // 20th to 23rd, plus today so far
    const c = creditSummary(snap, TODAY, { usd: 100, asOf: '2026-11-20', expires: '2026-12-10' })
    expect(c.left).toBeCloseTo(100 - 8.8, 1)
    expect(c).toMatchObject({ leftFrom: 'typed', runsOut: '2026-12-10', runsOutWhy: 'expires' })
    // Older than the daily window: months count pro rata.
    expect(creditsUsedSince(snap.raw, '2026-10-01')).toBeGreaterThan(creditsUsedSince(snap.raw, '2026-10-25'))
  })
  it('lists free tier use, items going over first', async () => {
    const c = creditSummary(await snapshot(), TODAY, noTyped)
    expect(c.freeTier.map((f) => f.service)).toEqual(['Amazon Simple Storage Service', 'Amazon Lightsail'])
    expect(c.freeTier[0].over).toBe(true)
  })
  it('older snapshots without credits still work', async () => {
    const snap = await snapshot()
    delete snap.raw.recordTypes; delete snap.credits
    const c = creditSummary(snap, TODAY, noTyped)
    expect(c.none).toBe(true)
    expect(c.left).toBeNull()
  })
  it('warns once a month when credits run out within 30 days', async () => {
    const snap = await snapshot({ dailyUsd: 2, creditShare: 1, planCreditsUsd: 20 })
    const c = creditSummary(snap, TODAY, noTyped)
    const first = dueAlerts(summarise(snap, TODAY), 0, parseAlertState(''), c, TODAY)
    expect(first.alerts.map((a) => a.key)).toEqual(['credits'])
    expect(first.alerts[0].subject).toContain('2026-12-04')
    expect(dueAlerts(summarise(snap, TODAY), 0, first.state, c, TODAY).alerts).toEqual([])
    const plenty = creditSummary(await snapshot({ dailyUsd: 2, creditShare: 1, planCreditsUsd: 500 }), TODAY, noTyped)
    expect(dueAlerts(summarise(snap, TODAY), 0, parseAlertState(''), plenty, TODAY).alerts).toEqual([])
  })
})

describe('alerts', () => {
  const base = { currency: 'AUD' as const, spikeMin: 2, month: '2026-11', monthToDate: 85, lastMonth: 90, forecast: 110, forecastFrom: 'aws' as const, services: [], lightsail: [], daily: [], monthly: [], lastDay: null }
  it('sends each budget level once a month, and the forecast once', () => {
    const first = dueAlerts(base, 100, parseAlertState(''))
    expect(first.alerts.map((a) => a.key)).toEqual(['actual80', 'forecast'])
    expect(first.alerts[0].subject).toContain('80%')
    expect(first.alerts[0].text).toContain('A$85.00')
    expect(dueAlerts(base, 100, first.state).alerts).toEqual([])
    const over = dueAlerts({ ...base, monthToDate: 120 }, 100, first.state)
    expect(over.alerts.map((a) => a.key)).toEqual(['actual100'])
    // A new month starts again.
    expect(dueAlerts({ ...base, month: '2026-12' }, 100, over.state).alerts.map((a) => a.key)).toEqual(['actual80', 'forecast'])
  })
  it('no budget = no budget alerts', () => {
    expect(dueAlerts(base, 0, parseAlertState('')).alerts).toEqual([])
  })
  it('a spike is more than twice the week and at least A$2 more, once per day', () => {
    expect(isSpike({ day: 'x', amount: 3, averageBefore: 3 })).toBe(false)
    expect(isSpike({ day: 'x', amount: 1.5, averageBefore: 0.5 })).toBe(false)
    expect(isSpike({ day: 'x', amount: 9, averageBefore: 3 })).toBe(true)
    const sum = { ...base, monthToDate: 10, forecast: 20, lastDay: { day: '2026-11-23', amount: 9, averageBefore: 3 } }
    const a = dueAlerts(sum, 0, parseAlertState(''))
    expect(a.alerts.map((x) => x.key)).toEqual(['spike'])
    expect(dueAlerts(sum, 0, a.state).alerts).toEqual([])
  })
})

describe('fetching', () => {
  let sent: string[]
  beforeEach(() => {
    freshEnv()
    sent = []
    setCostAlertSenderForTests((a) => { sent.push(a.key) })
    saveSettings({ costCurrency: 'AUD' })
    setRateFetcherForTests(async () => ({ rate: 1.53, date: '2026-11-23' }))
  })
  afterEach(() => { setCostSourceForTests(undefined); setCostAlertSenderForTests(undefined); setRateFetcherForTests(undefined) })

  it('keeps a snapshot at the day\'s rate and sends due alerts', async () => {
    setCostSourceForTests(new FakeCostSource({ dailyUsd: 2, spikeLastDay: 12 }))
    saveSettings({ costBudget: 85 })
    expect(await refreshCosts('test', TODAY)).toBeNull()
    const snap = latestSnapshot()!
    expect(snap.rate).toBe(1.53)
    expect(snap.rateSource).toBe('daily')
    expect(sent).toEqual(['actual80', 'forecast', 'spike'])
    expect(JSON.parse(getSettings().costAlertState).sent).toContain('forecast')
    expect(fetchDue(new Date(TODAY.getTime() + 3_600_000))).toBe(false)
    expect(fetchDue(new Date(TODAY.getTime() + 25 * 3_600_000))).toBe(true)
  })
  it('uses a typed rate, and the last known one when the rate service is down', async () => {
    setCostSourceForTests(new FakeCostSource())
    saveSettings({ costRate: 1.6 })
    await refreshCosts('test', TODAY)
    expect(latestSnapshot()!.rateSource).toBe('typed')
    saveSettings({ costRate: 0 })
    setRateFetcherForTests(async () => { throw new Error('offline') })
    await refreshCosts('test', TODAY)
    expect(latestSnapshot()!).toMatchObject({ rate: 1.6, rateSource: 'last known' })
  })
  it('records a failure with a hint and retries after 3 hours', async () => {
    const src = new FakeCostSource()
    src.costs = async () => { const e = new Error('User is not authorized'); e.name = 'AccessDeniedException'; throw e }
    setCostSourceForTests(src)
    const error = await refreshCosts('test', TODAY)
    expect(error).toMatch(/AccessDeniedException.*Billing information/)
    expect(lastAttempt()).toMatchObject({ ok: false })
    expect(latestSnapshot()).toBeNull()
    expect(fetchDue(new Date(TODAY.getTime() + 2 * 3_600_000))).toBe(false)
    expect(fetchDue(new Date(TODAY.getTime() + 3 * 3_600_000))).toBe(true)
  })
  it('saves an AWS budget through the source', async () => {
    const src = new FakeCostSource()
    await src.saveBudget(98.04, ['a@example.com'])
    expect(src.budgets).toEqual([{ amountUsd: 98.04, emails: ['a@example.com'] }])
  })
})
