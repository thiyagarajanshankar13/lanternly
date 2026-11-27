import { CostExplorerClient, GetCostAndUsageCommand, GetCostForecastCommand, type GetCostAndUsageCommandInput, type ResultByTime } from '@aws-sdk/client-cost-explorer'
import { BudgetsClient, CreateBudgetCommand, DeleteBudgetCommand, DuplicateRecordException } from '@aws-sdk/client-budgets'
import { GetBucketBundlesCommand, GetBucketsCommand, GetBundlesCommand, GetInstancesCommand, LightsailClient } from '@aws-sdk/client-lightsail'
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts'
import { FreeTierClient, GetAccountPlanStateCommand, GetFreeTierUsageCommand, type FreeTierUsage } from '@aws-sdk/client-freetier'
import { isFakeEngine } from '@/lib/engine'
import { getSettings } from '@/lib/settings'

// The only code that talks to AWS billing: Cost Explorer (what was spent),
// Lightsail (which VMs and buckets exist, and their plan prices) and Budgets
// (an AWS-side alert that works even when the deployer is down).
//
// Cost Explorer charges US$0.01 per call. A fetch makes 5, once a day. The Free
// Tier API (credits left on the AWS free plan, free tier use) is free.

/** One day or month of spend. `groups` is by AWS service or Lightsail usage type. */
export type CostPeriod = { start: string; total: number; groups: Record<string, number> }

export type RawCosts = {
  /** Up to 6 whole months plus this one, by AWS service. */
  monthly: CostPeriod[]
  /** The last 31 days (this one partial), by record type (Usage, Credit, Tax…). */
  daily: CostPeriod[]
  /** The same months as `monthly`, by record type: charges before credits, credits, refunds, tax.
   *  Missing in snapshots made before credits were shown. */
  recordTypes?: CostPeriod[]
  /** Last month and this one, Lightsail only, by usage type. */
  lightsail: CostPeriod[]
  /** Forecast spend for the rest of this month (null when AWS can't forecast yet). */
  forecastRest: number | null
  currency: string
}

export type LightsailResource = {
  kind: 'instance' | 'bucket'
  name: string
  plan: string
  /** Plan price, US$ a month. */
  monthlyUsd: number
  publicIp: string
  privateIp: string
  state: string
}

/** Free tier use of one item (what AWS gives free each month or for the first months). */
export type FreeTierItem = { service: string; description: string; actual: number; forecast: number; limit: number; unit: string; type: string }

export type CreditInfo = {
  /** The AWS free plan (accounts made since July 2025): credits left and when the plan ends. Null when not on it. */
  plan: { type: string; status: string; remainingUsd: number | null; expires: string | null } | null
  freeTier: FreeTierItem[]
  /** Why a part couldn't be read (shown small on the page; never fails the fetch). */
  errors: string[]
}

export interface CostSource {
  readonly label: string
  costs(today: Date): Promise<RawCosts>
  resources(): Promise<LightsailResource[]>
  credits(): Promise<CreditInfo>
  /** Creates (or replaces) the AWS budget "avro-deployer-monthly". */
  saveBudget(amountUsd: number, emails: string[]): Promise<void>
}

export const BUDGET_NAME = 'avro-deployer-monthly'

const ymd = (d: Date) => d.toISOString().slice(0, 10)
const utcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
export const monthStart = (d: Date, add = 0) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + add, 1))
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000)

/** The date ranges a fetch asks for (Cost Explorer end dates are exclusive). */
export function costRanges(today: Date) {
  const tomorrow = addDays(utcDay(today), 1)
  return {
    monthly: { Start: ymd(monthStart(today, -6)), End: ymd(tomorrow) },
    daily: { Start: ymd(addDays(tomorrow, -31)), End: ymd(tomorrow) },
    lightsail: { Start: ymd(monthStart(today, -1)), End: ymd(tomorrow) },
    recordTypes: { Start: ymd(monthStart(today, -6)), End: ymd(tomorrow) },
    forecast: { Start: ymd(tomorrow), End: ymd(monthStart(today, 1)) },
  }
}

const amount = (m?: { Amount?: string }) => Math.round(Number(m?.Amount ?? 0) * 100) / 100

function toPeriods(results: ResultByTime[]): CostPeriod[] {
  return results.map((r) => {
    const groups: Record<string, number> = {}
    for (const g of r.Groups ?? []) {
      const key = g.Keys?.[0] ?? 'Other'
      groups[key] = Math.round(((groups[key] ?? 0) + Number(g.Metrics?.UnblendedCost?.Amount ?? 0)) * 100) / 100
    }
    const total = r.Groups?.length ? Math.round(Object.values(groups).reduce((a, b) => a + b, 0) * 100) / 100 : amount(r.Total?.UnblendedCost)
    return { start: r.TimePeriod?.Start ?? '', total, groups }
  })
}

export class AwsCostSource implements CostSource {
  readonly label = 'AWS Cost Explorer'
  private creds: { accessKeyId: string; secretAccessKey: string }
  constructor(accessKeyId: string, secretAccessKey: string, private readonly region: string) {
    this.creds = { accessKeyId, secretAccessKey }
  }

  private async usage(input: GetCostAndUsageCommandInput): Promise<ResultByTime[]> {
    // Cost Explorer only answers in us-east-1, whatever region the resources are in.
    const ce = new CostExplorerClient({ region: 'us-east-1', credentials: this.creds })
    const out: ResultByTime[] = []
    let token: string | undefined
    do {
      const page = await ce.send(new GetCostAndUsageCommand({ ...input, NextPageToken: token }))
      // Pages repeat a period when its groups run over; merge them.
      for (const r of page.ResultsByTime ?? []) {
        const same = out.find((o) => o.TimePeriod?.Start === r.TimePeriod?.Start)
        if (same) same.Groups = [...(same.Groups ?? []), ...(r.Groups ?? [])]
        else out.push(r)
      }
      token = page.NextPageToken
    } while (token)
    return out
  }

  async costs(today: Date): Promise<RawCosts> {
    const r = costRanges(today)
    const metric = ['UnblendedCost']
    const byRecord = [{ Type: 'DIMENSION' as const, Key: 'RECORD_TYPE' }]
    const [monthly, daily, lightsail, recordTypes] = await Promise.all([
      this.usage({ TimePeriod: r.monthly, Granularity: 'MONTHLY', Metrics: metric, GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }] }),
      this.usage({ TimePeriod: r.daily, Granularity: 'DAILY', Metrics: metric, GroupBy: byRecord }),
      this.usage({ TimePeriod: r.lightsail, Granularity: 'MONTHLY', Metrics: metric, GroupBy: [{ Type: 'DIMENSION', Key: 'USAGE_TYPE' }],
        Filter: { Dimensions: { Key: 'SERVICE', Values: ['Amazon Lightsail'] } } }),
      this.usage({ TimePeriod: r.recordTypes, Granularity: 'MONTHLY', Metrics: metric, GroupBy: byRecord }),
    ])
    let forecastRest: number | null = null
    if (r.forecast.Start < r.forecast.End) {
      try {
        const ce = new CostExplorerClient({ region: 'us-east-1', credentials: this.creds })
        const f = await ce.send(new GetCostForecastCommand({ TimePeriod: r.forecast, Granularity: 'MONTHLY', Metric: 'UNBLENDED_COST' }))
        forecastRest = amount(f.Total)
      } catch (err) {
        // A new account (or a quiet one) has too little history to forecast.
        if ((err as Error).name !== 'DataUnavailableException') throw err
      }
    } else forecastRest = 0
    const currency = monthly[0]?.Total?.UnblendedCost?.Unit || monthly[0]?.Groups?.[0]?.Metrics?.UnblendedCost?.Unit || 'USD'
    return { monthly: toPeriods(monthly), daily: toPeriods(daily), lightsail: toPeriods(lightsail), recordTypes: toPeriods(recordTypes), forecastRest, currency }
  }

  async resources(): Promise<LightsailResource[]> {
    const ls = new LightsailClient({ region: this.region, credentials: this.creds })
    const [instances, bundles, buckets, bucketBundles] = await Promise.all([
      ls.send(new GetInstancesCommand({})), ls.send(new GetBundlesCommand({ includeInactive: true })),
      ls.send(new GetBucketsCommand({})), ls.send(new GetBucketBundlesCommand({ includeInactive: true })),
    ])
    const price = new Map((bundles.bundles ?? []).map((b) => [b.bundleId, { price: b.price ?? 0, name: `${b.ramSizeInGb ?? '?'} GB RAM, ${b.cpuCount ?? '?'} vCPU` }]))
    const bucketPrice = new Map((bucketBundles.bundles ?? []).map((b) => [b.bundleId, { price: b.price ?? 0, name: `${b.storagePerMonthInGb ?? '?'} GB` }]))
    return [
      ...(instances.instances ?? []).map((i): LightsailResource => ({
        kind: 'instance', name: i.name ?? '', plan: price.get(i.bundleId)?.name ?? i.bundleId ?? '', monthlyUsd: price.get(i.bundleId)?.price ?? 0,
        publicIp: i.publicIpAddress ?? '', privateIp: i.privateIpAddress ?? '', state: i.state?.name ?? '',
      })),
      ...(buckets.buckets ?? []).map((b): LightsailResource => ({
        kind: 'bucket', name: b.name ?? '', plan: bucketPrice.get(b.bundleId)?.name ?? b.bundleId ?? '', monthlyUsd: bucketPrice.get(b.bundleId)?.price ?? 0,
        publicIp: '', privateIp: '', state: b.state?.code ?? '',
      })),
    ]
  }

  async credits(): Promise<CreditInfo> {
    // The Free Tier API answers in us-east-1 only.
    const ft = new FreeTierClient({ region: 'us-east-1', credentials: this.creds })
    const out: CreditInfo = { plan: null, freeTier: [], errors: [] }
    const [plan, usage] = await Promise.allSettled([
      ft.send(new GetAccountPlanStateCommand({})),
      (async () => {
        const items: FreeTierUsage[] = []
        let nextToken: string | undefined
        do {
          const page = await ft.send(new GetFreeTierUsageCommand({ maxResults: 100, nextToken }))
          items.push(...(page.freeTierUsages ?? []))
          nextToken = page.nextToken
        } while (nextToken && items.length < 500)
        return items
      })(),
    ])
    if (plan.status === 'fulfilled') {
      const p = plan.value
      if (p.accountPlanType && p.accountPlanType !== 'PAID') {
        out.plan = {
          type: String(p.accountPlanType), status: String(p.accountPlanStatus ?? ''),
          remainingUsd: p.accountPlanRemainingCredits?.amount ?? null,
          expires: p.accountPlanExpirationDate ? new Date(p.accountPlanExpirationDate).toISOString().slice(0, 10) : null,
        }
      }
    } else if (!/ResourceNotFound|Validation/.test((plan.reason as Error).name ?? '')) out.errors.push(`Free plan: ${awsErrorText(plan.reason)}`)
    if (usage.status === 'fulfilled') {
      out.freeTier = usage.value.map((u) => ({
        service: u.service ?? '', description: u.description ?? u.usageType ?? '', actual: u.actualUsageAmount ?? 0,
        forecast: u.forecastedUsageAmount ?? 0, limit: u.limit ?? 0, unit: u.unit ?? '', type: u.freeTierType ?? '',
      }))
    } else out.errors.push(`Free tier: ${awsErrorText(usage.reason)}`)
    return out
  }

  async saveBudget(amountUsd: number, emails: string[]) {
    const who = await new STSClient({ region: this.region, credentials: this.creds }).send(new GetCallerIdentityCommand({}))
    const AccountId = who.Account!
    const budgets = new BudgetsClient({ region: 'us-east-1', credentials: this.creds })
    const subscribers = emails.slice(0, 10).map((Address) => ({ SubscriptionType: 'EMAIL' as const, Address }))
    const note = (NotificationType: 'ACTUAL' | 'FORECASTED', Threshold: number) => ({
      Notification: { NotificationType, ComparisonOperator: 'GREATER_THAN' as const, Threshold, ThresholdType: 'PERCENTAGE' as const }, Subscribers: subscribers,
    })
    const input = {
      AccountId,
      Budget: { BudgetName: BUDGET_NAME, BudgetType: 'COST' as const, TimeUnit: 'MONTHLY' as const, BudgetLimit: { Amount: amountUsd.toFixed(2), Unit: 'USD' } },
      NotificationsWithSubscribers: [note('ACTUAL', 80), note('ACTUAL', 100), note('FORECASTED', 100)],
    }
    try {
      await budgets.send(new CreateBudgetCommand(input))
    } catch (err) {
      if (!(err instanceof DuplicateRecordException) && (err as Error).name !== 'DuplicateRecordException') throw err
      // Replacing is the simplest way to change both the amount and every notification.
      await budgets.send(new DeleteBudgetCommand({ AccountId, BudgetName: BUDGET_NAME }))
      await budgets.send(new CreateBudgetCommand(input))
    }
  }
}

/** Practice mode and tests: steady made-up numbers in the shape AWS returns. */
export class FakeCostSource implements CostSource {
  readonly label = 'practice numbers'
  budgets: { amountUsd: number; emails: string[] }[] = []
  /** `creditShare`: credits as a share of what is paid (0.5 = for every US$1 paid, US$0.50 more was covered by credits). */
  constructor(private readonly opts: { dailyUsd?: number; spikeLastDay?: number; creditShare?: number; planCreditsUsd?: number } = {}) {}
  async costs(today: Date): Promise<RawCosts> {
    const r = costRanges(today)
    const perDay = this.opts.dailyUsd ?? 2.1
    const daily: CostPeriod[] = []
    const creditShare = this.opts.creditShare ?? 0
    const split3 = (t: number) => {
      const credit = Math.round(t * creditShare * 100) / 100
      return { Usage: Math.round((t + credit) * 0.93 * 100) / 100, Tax: Math.round(((t + credit) * 0.07) * 100) / 100, Credit: -credit }
    }
    const sum = (g: Record<string, number>) => Math.round(Object.values(g).reduce((a, b) => a + b, 0) * 100) / 100
    for (let d = new Date(`${r.daily.Start}T00:00:00Z`); ymd(d) < r.daily.End; d = addDays(d, 1)) {
      const isToday = ymd(d) === ymd(today)
      const isYesterday = ymd(d) === ymd(addDays(utcDay(today), -1))
      const v = isToday ? perDay * 0.4 : isYesterday && this.opts.spikeLastDay ? this.opts.spikeLastDay : perDay
      const groups = split3(Math.round(v * 100) / 100)
      daily.push({ start: ymd(d), total: sum(groups), groups })
    }
    const split = (t: number) => ({ 'Amazon Lightsail': Math.round(t * 0.93 * 100) / 100, 'AWS Cost Explorer': 0.12, Tax: Math.round((t * 0.07 - 0.12) * 100) / 100 })
    const monthly: CostPeriod[] = []
    for (let m = monthStart(today, -6); m <= monthStart(today); m = monthStart(m, 1)) {
      const days = m.getTime() === monthStart(today).getTime() ? today.getUTCDate() - 0.6 : new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 0)).getUTCDate()
      const t = Math.round(perDay * days * 100) / 100
      monthly.push({ start: ymd(m), total: t, groups: split(t) })
    }
    const ls = (t: number) => {
      const l = Math.round(t * 0.93 * 100) / 100
      return { start: '', total: l, groups: { 'APS2-BundleUsage:8GB': Math.round(l * 0.72 * 100) / 100, 'APS2-BundleUsage:2GB': Math.round(l * 0.2 * 100) / 100, 'APS2-BucketBundleUsage:100GB': Math.round(l * 0.06 * 100) / 100, 'APS2-DataXfer-Out-Bytes': Math.round(l * 0.02 * 100) / 100 } }
    }
    const lightsail = monthly.slice(-2).map((m) => ({ ...ls(m.total), start: m.start }))
    const recordTypes = monthly.map((m) => { const groups = split3(m.total); return { start: m.start, total: sum(groups), groups } })
    const rest = Math.max(0, (new Date(`${r.forecast.End}T00:00:00Z`).getTime() - new Date(`${r.forecast.Start}T00:00:00Z`).getTime()) / 86_400_000)
    return { monthly, daily, lightsail, recordTypes, forecastRest: Math.round(perDay * rest * 100) / 100, currency: 'USD' }
  }
  async resources(): Promise<LightsailResource[]> {
    return [
      { kind: 'instance', name: 'avro-sites-1', plan: '8 GB RAM, 2 vCPU', monthlyUsd: 44, publicIp: '203.0.113.10', privateIp: '172.26.0.10', state: 'running' },
      { kind: 'instance', name: 'avro-deployer', plan: '2 GB RAM, 2 vCPU', monthlyUsd: 12, publicIp: '203.0.113.20', privateIp: '172.26.0.20', state: 'running' },
      { kind: 'bucket', name: 'deployer-backups', plan: '100 GB', monthlyUsd: 3, publicIp: '', privateIp: '', state: 'OK' },
    ]
  }
  async credits(): Promise<CreditInfo> {
    return {
      plan: this.opts.planCreditsUsd !== undefined ? { type: 'FREE', status: 'ACTIVE', remainingUsd: this.opts.planCreditsUsd, expires: '2027-05-01' } : null,
      freeTier: [
        { service: 'Amazon Lightsail', description: '750 hours of a Lightsail plan for the first 3 months', actual: 412, forecast: 744, limit: 750, unit: 'Hrs', type: 'Trial' },
        { service: 'AWS Cost Explorer', description: 'Cost Explorer API: not free', actual: 0, forecast: 0, limit: 0, unit: 'Requests', type: '' },
        { service: 'Amazon Simple Storage Service', description: '5 GB of S3 standard storage', actual: 6.1, forecast: 6.4, limit: 5, unit: 'GB-Mo', type: '12 Months Free' },
      ],
      errors: [],
    }
  }
  async saveBudget(amountUsd: number, emails: string[]) { this.budgets.push({ amountUsd, emails }) }
}

const g = globalThis as unknown as { __costSourceForTests?: CostSource; __fakeCostSource?: FakeCostSource }
export function setCostSourceForTests(source: CostSource | undefined) { g.__costSourceForTests = source }

/** The configured source, or null when no AWS billing key is saved. */
export function costSource(): CostSource | null {
  if (g.__costSourceForTests) return g.__costSourceForTests
  const s = getSettings()
  if (s.costAccessKeyId && s.costSecretAccessKey) return new AwsCostSource(s.costAccessKeyId, s.costSecretAccessKey, s.costRegion || 'ap-southeast-2')
  if (isFakeEngine()) return (g.__fakeCostSource ??= new FakeCostSource({ creditShare: 0.6, planCreditsUsd: 74.2 }))
  return null
}

/** What the AWS key needs: paste as an inline policy on its IAM user. */
export const IAM_POLICY = JSON.stringify({
  Version: '2012-10-17',
  Statement: [
    { Sid: 'ReadCosts', Effect: 'Allow', Action: ['ce:GetCostAndUsage', 'ce:GetCostForecast'], Resource: '*' },
    { Sid: 'ReadCreditsAndFreeTier', Effect: 'Allow', Action: ['freetier:GetFreeTierUsage', 'freetier:GetAccountPlanState'], Resource: '*' },
    { Sid: 'ReadLightsailPlans', Effect: 'Allow', Action: ['lightsail:GetInstances', 'lightsail:GetBundles', 'lightsail:GetBuckets', 'lightsail:GetBucketBundles'], Resource: '*' },
    { Sid: 'KeepOneBudget', Effect: 'Allow', Action: ['budgets:ViewBudget', 'budgets:ModifyBudget'], Resource: `arn:aws:budgets::*:budget/${BUDGET_NAME}` },
  ],
}, null, 2)

/** A readable reason for an AWS error, with a hint for the usual set-up mistakes. */
export function awsErrorText(err: unknown): string {
  const e = err as Error & { name?: string; $metadata?: { httpStatusCode?: number } }
  const name = e.name && e.name !== 'Error' ? e.name : ''
  let hint = ''
  if (/AccessDenied|UnauthorizedOperation|AccessDeniedException/.test(name) || e.$metadata?.httpStatusCode === 403) hint = ' The key was refused: check it has the policy shown under "AWS key", and that "IAM user and role access to Billing information" is on in the AWS account settings.'
  else if (/UnrecognizedClient|InvalidClientTokenId|SignatureDoesNotMatch/.test(name)) hint = ' The access key ID or secret is wrong.'
  else if (/DataUnavailable/.test(name)) hint = ' Cost Explorer has no data yet: turn it on in Billing > Cost Explorer; the first numbers take up to 24 hours.'
  return `${name ? `${name}: ` : ''}${e.message || 'AWS did not answer.'}${hint}`
}
