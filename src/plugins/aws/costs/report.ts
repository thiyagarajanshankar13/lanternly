import type { CostPeriod, CreditInfo, FreeTierItem, LightsailResource, RawCosts } from './aws'
import { fmtMoney as money, type CurrencyCode } from '../money'

// Pure maths for the Costs page and the cost alerts (tested in tests/costs.test.ts).
// AWS reports in US$; everything shown is in the snapshot's currency at its rate.

export type Snapshot = {
  fetchedAt: string
  raw: RawCosts
  resources: LightsailResource[]
  /** The currency shown (missing in snapshots from before it was a setting: those are A$). */
  currency?: CurrencyCode
  /** Units of that currency per US$ (1 for US$). Older snapshots stored it as usdToAud. */
  rate: number
  rateSource: 'typed' | 'daily' | 'last known' | 'fallback' | 'none'
  rateDate: string
  /** Free plan credits and free tier use (missing in older snapshots). */
  credits?: CreditInfo
}

export type Line = { name: string; amount: number; lastAmount: number }

export type CostSummary = {
  currency: CurrencyCode
  /** The smallest jump in a day that counts as a spike, in that currency. */
  spikeMin: number
  month: string
  monthToDate: number
  lastMonth: number
  forecast: number
  /** Forecast from AWS, or our straight-line guess when AWS can't forecast yet. */
  forecastFrom: 'aws' | 'estimate'
  services: Line[]
  lightsail: Line[]
  daily: { day: string; amount: number }[]
  monthly: { month: string; amount: number }[]
  /** The last whole day (UTC) and the average of the 7 before it. */
  lastDay: { day: string; amount: number; averageBefore: number } | null
}

const r2 = (n: number) => Math.round(n * 100) / 100
const ym = (iso: string) => iso.slice(0, 7)

/** Which part of Lightsail a usage type is, from names like APS2-BundleUsage:8GB. */
export function lightsailPart(usageType: string): string {
  const u = usageType.toLowerCase()
  if (u.includes('bucket')) return 'Bucket (backups)'
  if (u.includes('snapshot')) return 'Snapshots'
  if (u.includes('database') || u.includes('dbbundle')) return 'Databases'
  if (u.includes('staticip') || u.includes('ipv4') || u.includes('publicip')) return 'Static IPs'
  if (u.includes('dataxfer') || u.includes('datatransfer') || u.includes('bytes')) return 'Data transfer'
  if (u.includes('loadbalancer')) return 'Load balancers'
  if (u.includes('bundleusage') || u.includes('instance')) return 'VMs'
  return 'Other'
}

function lines(cur: Record<string, number>, last: Record<string, number>, rate: number, key = (k: string) => k): Line[] {
  const out = new Map<string, Line>()
  const add = (k: string, v: number, field: 'amount' | 'lastAmount') => {
    const name = key(k)
    const l = out.get(name) ?? { name, amount: 0, lastAmount: 0 }
    l[field] = r2(l[field] + v * rate)
    out.set(name, l)
  }
  for (const [k, v] of Object.entries(cur)) add(k, v, 'amount')
  for (const [k, v] of Object.entries(last)) add(k, v, 'lastAmount')
  return [...out.values()].filter((l) => l.amount >= 0.005 || l.lastAmount >= 0.005 || l.amount <= -0.005).sort((a, b) => b.amount - a.amount || b.lastAmount - a.lastAmount)
}

export function summarise(s: Snapshot, today = new Date(s.fetchedAt)): CostSummary {
  const rate = s.rate
  const month = today.toISOString().slice(0, 7)
  const lastMonthKey = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1)).toISOString().slice(0, 7)
  const find = (list: CostPeriod[], key: string) => list.find((p) => ym(p.start) === key)
  const cur = find(s.raw.monthly, month)
  const last = find(s.raw.monthly, lastMonthKey)
  const monthToDate = r2((cur?.total ?? 0) * rate)
  const daysInMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0)).getUTCDate()
  const elapsed = Math.max(1, today.getUTCDate() - 1 + today.getUTCHours() / 24)
  const forecastFrom = s.raw.forecastRest === null ? 'estimate' : 'aws'
  const forecast = s.raw.forecastRest === null ? r2((monthToDate / elapsed) * daysInMonth) : r2(monthToDate + s.raw.forecastRest * rate)

  const daily = s.raw.daily.map((d) => ({ day: d.start, amount: r2(d.total * rate) }))
  const todayKey = today.toISOString().slice(0, 10)
  const whole = daily.filter((d) => d.day < todayKey)
  const lastDayRow = whole[whole.length - 1]
  const before = whole.slice(-8, -1)
  const lastDay = lastDayRow && before.length >= 3
    ? { day: lastDayRow.day, amount: lastDayRow.amount, averageBefore: r2(before.reduce((a, b) => a + b.amount, 0) / before.length) }
    : null

  const currency = s.currency ?? 'AUD'
  return {
    currency, spikeMin: spikeMinFor(currency, rate),
    month, monthToDate, lastMonth: r2((last?.total ?? 0) * rate), forecast, forecastFrom,
    services: lines(cur?.groups ?? {}, last?.groups ?? {}, rate),
    lightsail: lines(find(s.raw.lightsail, month)?.groups ?? {}, find(s.raw.lightsail, lastMonthKey)?.groups ?? {}, rate, lightsailPart),
    daily,
    monthly: s.raw.monthly.map((m) => ({ month: ym(m.start), amount: r2(m.total * rate) })),
    lastDay,
  }
}

// ---- per-site estimate ----

export type AllocServer = { id: number; name: string; host: string; publicIp: string }
export type AllocSite = { id: number; name: string; displayName: string; serverId: number; memoryMb: number; running: boolean; bucketBytes: number }
export type SiteCost = { id: number; name: string; displayName: string; server: string; vm: number; bucket: number; shared: number; total: number }
export type Allocation = {
  sites: SiteCost[]
  /** Server id → the Lightsail VM matched to it (by IP). */
  serverVm: Map<number, LightsailResource>
  /** VMs that run no sites (the deployer, with the AI assistant): split evenly. */
  sharedVms: LightsailResource[]
  /** A server with sites but no Lightsail VM found for it. */
  unmatched: AllocServer[]
  /** A month of every Lightsail VM and bucket at plan price. */
  planTotal: number
}

/**
 * What each site costs a month, at Lightsail plan prices: its server's price split
 * by the memory of the running sites on it, the bucket split by backup size, and
 * every other VM (the deployer, the AI assistant) split evenly between running sites.
 */
export function allocate(sites: AllocSite[], servers: AllocServer[], resources: LightsailResource[], rate: number): Allocation {
  const vms = resources.filter((r) => r.kind === 'instance')
  const buckets = resources.filter((r) => r.kind === 'bucket')
  const serverVm = new Map<number, LightsailResource>()
  for (const s of servers) {
    const vm = vms.find((v) => [v.publicIp, v.privateIp].filter(Boolean).some((ip) => ip === s.publicIp || ip === s.host))
    if (vm) serverVm.set(s.id, vm)
  }
  const used = new Set(serverVm.values())
  const sharedVms = vms.filter((v) => !used.has(v))
  const running = sites.filter((s) => s.running)
  const memOn = new Map<number, number>()
  for (const s of running) memOn.set(s.serverId, (memOn.get(s.serverId) ?? 0) + Math.max(1, s.memoryMb))
  const totalBytes = sites.reduce((a, s) => a + s.bucketBytes, 0)
  const bucketCost = buckets.reduce((a, b) => a + b.monthlyUsd, 0) * rate
  const sharedCost = sharedVms.reduce((a, v) => a + v.monthlyUsd, 0) * rate
  const byId = new Map(servers.map((s) => [s.id, s]))
  const out: SiteCost[] = sites.map((s) => {
    const vm = serverVm.get(s.serverId)
    const vmShare = s.running && vm ? (vm.monthlyUsd * rate * Math.max(1, s.memoryMb)) / (memOn.get(s.serverId) ?? 1) : 0
    const bucket = totalBytes ? (bucketCost * s.bucketBytes) / totalBytes : 0
    const shared = s.running && running.length ? sharedCost / running.length : 0
    return { id: s.id, name: s.name, displayName: s.displayName, server: byId.get(s.serverId)?.name ?? '', vm: r2(vmShare), bucket: r2(bucket), shared: r2(shared), total: r2(vmShare + bucket + shared) }
  }).sort((a, b) => b.total - a.total)
  const withSites = new Set(sites.map((s) => s.serverId))
  return {
    sites: out, serverVm, sharedVms,
    unmatched: servers.filter((s) => withSites.has(s.id) && !serverVm.has(s.id)),
    planTotal: r2(resources.reduce((a, r) => a + r.monthlyUsd, 0) * rate),
  }
}

export type ProjectCost = { id: number; name: string; services: number; vm: number; bucket: number; shared: number; total: number }

/**
 * What each project costs a month: its services' server and bucket shares added
 * up, and the shared VMs split evenly between the projects that have something
 * running (not per service, so a project of five services doesn't pay five shares).
 */
export function allocateProjects(alloc: Allocation, projects: { id: number; name: string }[], projectOf: (siteId: number) => number | null, runningIds: Set<number>, rate: number): ProjectCost[] {
  const sharedCost = alloc.sharedVms.reduce((a, v) => a + v.monthlyUsd, 0) * rate
  const live = new Set(alloc.sites.filter((s) => runningIds.has(s.id)).map((s) => projectOf(s.id)).filter((p): p is number => p !== null))
  return projects.map((p) => {
    const mine = alloc.sites.filter((s) => projectOf(s.id) === p.id)
    const vm = mine.reduce((a, s) => a + s.vm, 0)
    const bucket = mine.reduce((a, s) => a + s.bucket, 0)
    const shared = live.has(p.id) ? sharedCost / live.size : 0
    return { id: p.id, name: p.name, services: mine.length, vm: r2(vm), bucket: r2(bucket), shared: r2(shared), total: r2(vm + bucket + shared) }
  }).filter((p) => p.services > 0).sort((a, b) => b.total - a.total)
}

// ---- credits: what AWS charged, what credits covered, what is left to pay ----

export type MonthPay = { month: string; charges: number; credits: number; discounts: number; pay: number }
export type TypedCredits = { usd: number; asOf: string; expires: string }
export type CreditSummary = {
  months: MonthPay[]
  thisMonth: MonthPay
  lastMonth: MonthPay
  /** Forecast of the month's charges before credits (the main forecast is what you pay). */
  chargesForecast: number
  /** Credits left, in the snapshot currency; null when unknown. */
  left: number | null
  leftFrom: 'aws free plan' | 'typed' | null
  /** The typed balance's date, or null. */
  leftAsOf: string | null
  expires: string | null
  /** Credits used per day lately (last 7 whole days, else this month). */
  usePerDay: number
  /** When the credits run out at that pace, or expire, whichever is first. */
  runsOut: string | null
  runsOutWhy: 'used up' | 'expires' | null
  freeTier: (FreeTierItem & { pct: number; over: boolean })[]
  errors: string[]
  /** Nothing to show: no credits this year, none left, no free tier. */
  none: boolean
}

const isCredit = (k: string) => k === 'Credit'
const isDiscount = (k: string) => /refund|discount/i.test(k)

function monthPay(p: CostPeriod, rate: number): MonthPay {
  let credits = 0, discounts = 0
  for (const [k, v] of Object.entries(p.groups)) {
    if (isCredit(k)) credits -= v
    else if (isDiscount(k)) discounts -= v
  }
  return { month: ym(p.start), charges: r2((p.total + credits + discounts) * rate), credits: r2(credits * rate), discounts: r2(discounts * rate), pay: r2(p.total * rate) }
}

const DAY = 86_400_000
const dayMs = (d: string) => new Date(`${d}T00:00:00Z`).getTime()

/** US$ of credits used from `since` (YYYY-MM-DD) up to now: daily records where they reach, months (pro rata) before that. */
export function creditsUsedSince(raw: RawCosts, since: string): number {
  const credit = (p: CostPeriod) => -Object.entries(p.groups).filter(([k]) => isCredit(k)).reduce((a, [, v]) => a + v, 0)
  const dailyStart = raw.daily[0]?.start ?? '9999-12-31'
  let used = raw.daily.filter((d) => d.start >= since).reduce((a, d) => a + credit(d), 0)
  if (since < dailyStart) {
    for (const m of raw.recordTypes ?? []) {
      const start = dayMs(m.start)
      const next = new Date(start); next.setUTCMonth(next.getUTCMonth() + 1)
      const from = Math.max(start, dayMs(since)), to = Math.min(next.getTime(), dayMs(dailyStart))
      if (to > from) used += (credit(m) * (to - from)) / (next.getTime() - start)
    }
  }
  return r2(used)
}

export function creditSummary(s: Snapshot, today: Date, typed: TypedCredits): CreditSummary {
  const rate = s.rate
  const months = (s.raw.recordTypes ?? []).map((p) => monthPay(p, rate))
  const empty = (month: string): MonthPay => ({ month, charges: 0, credits: 0, discounts: 0, pay: 0 })
  const monthKey = today.toISOString().slice(0, 7)
  const lastKey = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1)).toISOString().slice(0, 7)
  const thisMonth = months.find((m) => m.month === monthKey) ?? empty(monthKey)
  const lastMonth = months.find((m) => m.month === lastKey) ?? empty(lastKey)

  const daysInMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0)).getUTCDate()
  const elapsed = Math.max(1, today.getUTCDate() - 1 + today.getUTCHours() / 24)
  const pay = summarise(s, today)
  const offPerDay = (thisMonth.credits + thisMonth.discounts) / elapsed
  const chargesForecast = r2(pay.forecast + thisMonth.credits + thisMonth.discounts + offPerDay * Math.max(0, daysInMonth - elapsed))

  // Credits left: live from the AWS free plan, else the admin's typed balance less what was used since.
  const plan = s.credits?.plan
  let leftUsd: number | null = null, leftFrom: CreditSummary['leftFrom'] = null, leftAsOf: string | null = null, expires: string | null = null
  if (plan && plan.remainingUsd !== null) { leftUsd = plan.remainingUsd; leftFrom = 'aws free plan'; expires = plan.expires }
  else if (typed.usd > 0 && /^\d{4}-\d{2}-\d{2}$/.test(typed.asOf)) {
    leftUsd = Math.max(0, typed.usd - creditsUsedSince(s.raw, typed.asOf)); leftFrom = 'typed'; leftAsOf = typed.asOf; expires = typed.expires || null
  }
  if (!expires && plan?.expires) expires = plan.expires

  const todayKey = today.toISOString().slice(0, 10)
  const whole = s.raw.daily.filter((d) => d.start < todayKey).slice(-7)
  const creditOf = (p: CostPeriod) => -Object.entries(p.groups).filter(([k]) => isCredit(k)).reduce((a, [, v]) => a + v, 0)
  const recent = whole.length ? whole.reduce((a, d) => a + creditOf(d), 0) / whole.length : 0
  // No credits used lately (a balance typed before AWS applies it): assume they'll cover the day's charges.
  const chargesPerDay = whole.length ? whole.reduce((a, d) => a + d.total + creditOf(d), 0) / whole.length : 0
  const usePerDayUsd = recent > 0.005 ? recent : chargesPerDay
  let runsOut: string | null = null, runsOutWhy: CreditSummary['runsOutWhy'] = null
  if (leftUsd !== null && leftUsd > 0) {
    if (usePerDayUsd > 0) { runsOut = new Date(dayMs(todayKey) + Math.floor(leftUsd / usePerDayUsd) * DAY).toISOString().slice(0, 10); runsOutWhy = 'used up' }
    if (expires && (!runsOut || expires < runsOut)) { runsOut = expires; runsOutWhy = 'expires' }
  }

  const freeTier = (s.credits?.freeTier ?? []).filter((f) => f.limit > 0 && (f.actual > 0 || f.forecast > 0))
    .map((f) => ({ ...f, pct: Math.round((f.actual / f.limit) * 100), over: f.forecast > f.limit || f.actual > f.limit }))
    .sort((a, b) => Number(b.over) - Number(a.over) || b.pct - a.pct)
  const anyCredits = months.some((m) => m.credits > 0 || m.discounts > 0)
  return {
    months, thisMonth, lastMonth, chargesForecast,
    left: leftUsd === null ? null : r2(leftUsd * rate), leftFrom, leftAsOf, expires,
    usePerDay: r2(usePerDayUsd * rate), runsOut, runsOutWhy, freeTier, errors: s.credits?.errors ?? [],
    none: !anyCredits && !leftUsd && !freeTier.length,
  }
}

// ---- alerts ----

export type AlertState = { month: string; sent: string[]; spikeDay: string }
export type CostAlert = { key: string; subject: string; text: string }

/** Budget levels that email once a month when this month's spend passes them. */
export const ACTUAL_LEVELS = [50, 80, 100]

export function parseAlertState(json: string): AlertState {
  try {
    const v = JSON.parse(json) as Partial<AlertState>
    return { month: String(v.month ?? ''), sent: Array.isArray(v.sent) ? v.sent.map(String) : [], spikeDay: String(v.spikeDay ?? '') }
  } catch { return { month: '', sent: [], spikeDay: '' } }
}

/** A$2 as before; in other currencies about the same (US$1.30). */
export function spikeMinFor(currency: CurrencyCode, rate: number): number {
  return currency === 'AUD' ? 2 : r2(1.3 * rate)
}

/** A day counts as a spike above twice the week's average, and at least min (A$2) more than it. */
export function isSpike(d: CostSummary['lastDay'], min = 2): boolean {
  return !!d && d.amount >= min && d.amount > d.averageBefore * 2 && d.amount - d.averageBefore >= min
}

/** The alerts due now, and the state to save once they're sent. */
export function dueAlerts(sum: CostSummary, budget: number, prev: AlertState, credits?: CreditSummary, today = new Date(), locale = 'en-AU'): { alerts: CostAlert[]; state: AlertState } {
  const fmtMoney = (n: number) => money(n, sum.currency, locale)
  const state: AlertState = prev.month === sum.month ? { ...prev, sent: [...prev.sent] } : { month: sum.month, sent: [], spikeDay: prev.spikeDay }
  const alerts: CostAlert[] = []
  const tail = `\n\nThis month so far: ${fmtMoney(sum.monthToDate)}. Forecast for the month: ${fmtMoney(sum.forecast)}.${budget > 0 ? ` Budget: ${fmtMoney(budget)}.` : ''}\nThe deployer's Costs page shows where it goes.`
  if (budget > 0) {
    const pct = (sum.monthToDate / budget) * 100
    const passed = ACTUAL_LEVELS.filter((l) => pct >= l && !state.sent.includes(`actual${l}`))
    if (passed.length) {
      const top = passed[passed.length - 1]
      for (const l of passed) state.sent.push(`actual${l}`)
      alerts.push({
        key: `actual${top}`,
        subject: top >= 100 ? `AWS spend is over budget (${fmtMoney(sum.monthToDate)} of ${fmtMoney(budget)})` : `AWS spend has passed ${top}% of the budget`,
        text: `AWS has charged ${fmtMoney(sum.monthToDate)} so far this month, ${Math.round(pct)}% of the ${fmtMoney(budget)} budget.${tail}`,
      })
    }
    if (sum.forecast > budget && !state.sent.includes('forecast') && !state.sent.includes('actual100')) {
      state.sent.push('forecast')
      alerts.push({
        key: 'forecast',
        subject: `AWS spend is heading over budget (forecast ${fmtMoney(sum.forecast)})`,
        text: `At the current rate this month's AWS bill will be about ${fmtMoney(sum.forecast)}, over the ${fmtMoney(budget)} budget.${tail}`,
      })
    }
  }
  // Credits about to end: once a month, when they run out or expire within 30 days.
  if (credits?.runsOut && credits.left && !state.sent.includes('credits') && dayMs(credits.runsOut) - today.getTime() <= 30 * DAY) {
    state.sent.push('credits')
    alerts.push({
      key: 'credits',
      subject: credits.runsOutWhy === 'expires' ? `AWS credits expire on ${credits.runsOut}` : `AWS credits run out around ${credits.runsOut}`,
      text: `About ${fmtMoney(credits.left)} of AWS credits is left${credits.runsOutWhy === 'expires' ? `, and they expire on ${credits.runsOut}` : `, used at about ${fmtMoney(credits.usePerDay)} a day, so they last until about ${credits.runsOut}`}. After that AWS charges the card for everything: about ${fmtMoney(credits.chargesForecast)} a month at the current rate.${tail}`,
    })
  }
  if (sum.lastDay && isSpike(sum.lastDay, sum.spikeMin) && state.spikeDay !== sum.lastDay.day) {
    state.spikeDay = sum.lastDay.day
    alerts.push({
      key: 'spike',
      subject: `AWS spend jumped on ${sum.lastDay.day} (${fmtMoney(sum.lastDay.amount)})`,
      text: `AWS charged ${fmtMoney(sum.lastDay.amount)} on ${sum.lastDay.day} (UTC), against an average of ${fmtMoney(sum.lastDay.averageBefore)} a day over the week before. Check for a new VM, a bigger plan, snapshots or a lot of data transfer.${tail}`,
    })
  }
  return { alerts, state }
}
