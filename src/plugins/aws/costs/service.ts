import { db } from '@/lib/db'
import { pluginOn } from '@/plugins'
import { mailReady, sendMail } from '@/lib/mail'
import { alertRecipients } from '@/lib/monitor'
import { displayLocale, getSettings, saveSettings } from '@/lib/settings'
import { FALLBACK_RATES, currencyOf, fmtMoney, type CurrencyCode } from '../money'
import { awsErrorText, costSource, type CreditInfo } from './aws'
import { creditSummary, dueAlerts, parseAlertState, summarise, type CostAlert, type Snapshot, type TypedCredits } from './report'

// Fetching costs from AWS, keeping them, and the cost alerts.
// Once a day by timer (and "Refresh now"); each fetch costs US$0.04 in Cost Explorer calls.

const KEEP_SNAPSHOTS = 60

type Row = { id: number; fetched_at: string; ok: number; error: string; data: string; created_by: string }
export type Attempt = { id: number; fetchedAt: string; ok: boolean; error: string; by: string }

export function latestSnapshot(): Snapshot | null {
  const row = db().prepare('SELECT * FROM cost_snapshots WHERE ok = 1 ORDER BY id DESC LIMIT 1').get() as Row | undefined
  if (!row) return null
  try { return normaliseSnapshot(JSON.parse(row.data)) } catch { return null }
}

/** Snapshots from before the currency setting kept the A$ rate as usdToAud. */
export function normaliseSnapshot(data: Snapshot & { usdToAud?: number }): Snapshot {
  const { usdToAud, ...rest } = data
  if (typeof rest.rate !== 'number' && typeof usdToAud === 'number') return { ...rest, rate: usdToAud, currency: rest.currency ?? 'AUD' }
  return { ...rest, currency: rest.currency ?? 'AUD' }
}

/** The currency costs are shown in. */
export function costCurrency(): CurrencyCode {
  return currencyOf(getSettings().costCurrency)
}

/** Formats amounts worked out from the latest snapshot: in its currency, in the deployer's locale. */
export function moneyFormatter(currency: CurrencyCode = latestSnapshot()?.currency ?? costCurrency()): (n: number) => string {
  const locale = displayLocale()
  return (n: number) => fmtMoney(n, currency, locale)
}

export function lastAttempt(): Attempt | null {
  const row = db().prepare('SELECT * FROM cost_snapshots ORDER BY id DESC LIMIT 1').get() as Row | undefined
  return row ? { id: row.id, fetchedAt: row.fetched_at, ok: !!row.ok, error: row.error, by: row.created_by } : null
}

/** The credit balance an admin typed from AWS Billing > Credits (for promotional credits AWS has no API for). */
export function typedCredits(): TypedCredits {
  const s = getSettings()
  return { usd: s.costCreditsUsd, asOf: s.costCreditsAsOf, expires: s.costCreditsExpire }
}

// ---- exchange rate ----

type RateFetcher = (currency: CurrencyCode) => Promise<{ rate: number; date: string }>
const g = globalThis as unknown as { __rateFetcher?: RateFetcher; __costSender?: (a: CostAlert) => void; __costTimer?: NodeJS.Timeout; __costBusy?: boolean }
export function setRateFetcherForTests(f: RateFetcher | undefined) { g.__rateFetcher = f }
export function setCostAlertSenderForTests(f: ((a: CostAlert) => void) | undefined) { g.__costSender = f }

/** The day's US$ → <currency> rate (European Central Bank, via Frankfurter: free, no key). */
async function fetchDailyRate(currency: CurrencyCode): Promise<{ rate: number; date: string }> {
  if (g.__rateFetcher) return g.__rateFetcher(currency)
  const res = await fetch(`https://api.frankfurter.dev/v1/latest?base=USD&symbols=${currency}`, { signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`rate service answered ${res.status}`)
  const body = (await res.json()) as { date?: string; rates?: Record<string, number> }
  const rate = Number(body.rates?.[currency])
  if (!(rate > 0 && rate < 100_000)) throw new Error(`rate service gave no ${currency} rate`)
  return { rate, date: String(body.date ?? '') }
}

export type DisplayRate = Required<Pick<Snapshot, 'currency'>> & Pick<Snapshot, 'rate' | 'rateSource' | 'rateDate'>

/**
 * How to turn AWS's US$ into the chosen currency: US$ needs nothing; else the rate
 * typed in Costs, the day's rate, the last one used, or a stand-in. With no rate at
 * all for a currency without a stand-in, money is shown in US$ (and the page says so).
 */
export async function displayRate(): Promise<DisplayRate> {
  const s = getSettings()
  const currency = currencyOf(s.costCurrency)
  if (currency === 'USD') return { currency, rate: 1, rateSource: 'none', rateDate: '' }
  if (s.costRate > 0) return { currency, rate: s.costRate, rateSource: 'typed', rateDate: '' }
  try {
    const { rate, date } = await fetchDailyRate(currency)
    return { currency, rate, rateSource: 'daily', rateDate: date }
  } catch (err) {
    console.error('[costs] exchange rate:', (err as Error).message)
    const last = latestSnapshot()
    if (last && (last.currency ?? 'AUD') === currency) return { currency, rate: last.rate, rateSource: 'last known', rateDate: last.rateDate }
    const fallback = FALLBACK_RATES[currency]
    if (fallback) return { currency, rate: fallback, rateSource: 'fallback', rateDate: '' }
    return { currency: 'USD', rate: 1, rateSource: 'fallback', rateDate: '' }
  }
}

// ---- fetching ----

/** Asks AWS for the latest numbers and keeps them. Returns null when done, else why not. */
export async function refreshCosts(by = 'schedule', at = new Date()): Promise<string | null> {
  const source = costSource()
  if (!source) return 'Add the AWS key first (AWS key on the Costs page).'
  let snap: Snapshot
  try {
    const [raw, resources, rate, credits] = await Promise.all([source.costs(at), source.resources(), displayRate(),
      source.credits().catch((err): CreditInfo => ({ plan: null, freeTier: [], errors: [awsErrorText(err)] }))])
    snap = { fetchedAt: at.toISOString(), raw, resources, ...rate, credits }
  } catch (err) {
    const error = awsErrorText(err)
    db().prepare('INSERT INTO cost_snapshots (fetched_at, ok, error, created_by) VALUES (?, 0, ?, ?)').run(at.toISOString(), error, by)
    prune()
    return error
  }
  db().prepare('INSERT INTO cost_snapshots (fetched_at, ok, data, created_by) VALUES (?, 1, ?, ?)').run(snap.fetchedAt, JSON.stringify(snap), by)
  prune()
  await runCostAlerts(snap, at)
  return null
}

function prune() {
  db().prepare('DELETE FROM cost_snapshots WHERE id NOT IN (SELECT id FROM cost_snapshots ORDER BY id DESC LIMIT ?)').run(KEEP_SNAPSHOTS)
}

/** Emails the alerts that are due (to Monitoring's alert people) and remembers them. */
export async function runCostAlerts(snap: Snapshot, at = new Date()): Promise<CostAlert[]> {
  const s = getSettings()
  const sum = summarise(snap, at)
  // A budget is in the chosen currency: no budget alerts while the numbers are in another one.
  const budget = sum.currency === costCurrency() ? s.costBudget : 0
  const { alerts, state } = dueAlerts(sum, budget, parseAlertState(s.costAlertState), creditSummary(snap, at, typedCredits()), at, displayLocale())
  for (const a of alerts) {
    if (g.__costSender) { g.__costSender(a); continue }
    if (!mailReady()) continue
    const error = await sendMail(alertRecipients(), a.subject, a.text)
    if (error) console.error(`[costs] alert not sent: ${error}`)
  }
  saveSettings({ costAlertState: JSON.stringify(state) })
  return alerts
}

/** A fetch is due once a day; after a failure it is tried again 3 hours later. */
export function fetchDue(at = new Date()): boolean {
  const last = lastAttempt()
  if (!last) return true
  const since = at.getTime() - new Date(last.fetchedAt).getTime()
  return since >= (last.ok ? 24 : 3) * 3_600_000
}

/** Checks hourly whether a fetch is due. DEPLOYER_COSTS=off stops it. */
export function startCostScheduler() {
  if (g.__costTimer || /^(0|false|no|off)$/i.test(process.env.DEPLOYER_COSTS || '')) return
  const tick = async () => {
    if (g.__costBusy || !pluginOn('aws') || !costSource() || !fetchDue()) return
    g.__costBusy = true
    try {
      const error = await refreshCosts('schedule')
      if (error) console.error('[costs]', error)
    } catch (err) {
      console.error('[costs]', (err as Error).message)
    } finally { g.__costBusy = false }
  }
  g.__costTimer = setInterval(() => void tick(), 3_600_000)
  g.__costTimer.unref?.()
  setTimeout(() => void tick(), 60_000).unref?.()
}

