'use server'

import { revalidatePath } from 'next/cache'
import { pluginOffError, requireOwner } from '@/lib/guards'
import { audit } from '@/lib/audit'
import { alertRecipients } from '@/lib/monitor'
import { getSettings, saveSettings } from '@/lib/settings'
import { awsErrorText, costSource } from '@/plugins/aws/costs/aws'
import { costCurrency, displayRate, latestSnapshot, refreshCosts, runCostAlerts } from '@/plugins/aws/costs/service'
import { currencySymbol, fmtMoney, isCurrency, rateOk } from '@/plugins/aws/money'

type FormState = { error?: string; ok?: string } | undefined
const str = (form: FormData, key: string) => String(form.get(key) ?? '').trim()
const money = (v: string) => Number(v.replace(/[^0-9.\-]/g, ''))

export async function saveCostKeyAction(_prev: FormState, form: FormData): Promise<FormState> {
  const admin = await requireOwner()
  const off = pluginOffError('aws')
  if (off) return { error: off }
  const id = str(form, 'costAccessKeyId')
  const secret = str(form, 'costSecretAccessKey')
  const region = str(form, 'costRegion') || 'ap-southeast-2'
  if (id && !/^(AKIA|ASIA)[A-Z0-9]{12,20}$/.test(id)) return { error: 'An access key ID starts with AKIA and has 16 to 24 capital letters and digits.' }
  if (!/^[a-z]{2}-[a-z]+-\d$/.test(region)) return { error: 'The region looks like ap-southeast-2 (Sydney).' }
  saveSettings({ costAccessKeyId: id, costRegion: region, ...(secret ? { costSecretAccessKey: secret } : {}), ...(!id ? { costSecretAccessKey: '' } : {}) })
  await audit(admin, 'costs', { detail: id ? 'AWS cost key saved' : 'AWS cost key removed' })
  if (!id) { revalidatePath('/admin/costs'); return { ok: 'AWS key removed. Costs are no longer fetched.' } }
  const error = await refreshCosts(`key saved`)
  revalidatePath('/admin/costs')
  return error ? { error: `Saved, but AWS didn't answer: ${error}` } : { ok: 'Saved. The latest costs are in.' }
}

export async function saveBudgetAction(_prev: FormState, form: FormData): Promise<FormState> {
  await requireOwner()
  const off = pluginOffError('aws')
  if (off) return { error: off }
  const before = getSettings()
  const wanted = str(form, 'costCurrency') || costCurrency()
  if (!isCurrency(wanted)) return { error: 'Pick one of the currencies in the list.' }
  const currencyChanged = wanted !== costCurrency()
  const sym = currencySymbol(wanted)
  const budget = str(form, 'costBudget') ? money(str(form, 'costBudget')) : 0
  // A rate typed for one currency means nothing in another: changing the currency clears it.
  const rate = wanted === 'USD' || currencyChanged ? 0 : str(form, 'costRate') ? Number(str(form, 'costRate')) : 0
  if (!(Number.isFinite(budget) && budget >= 0 && budget <= 100_000_000)) return { error: `The budget is an amount in ${sym}, like 150.` }
  if (!(rate === 0 || rateOk(rate))) return { error: `The rate is ${sym} for one US$, like 1.54, or empty for the day's rate.` }
  const credits = str(form, 'costCreditsUsd') ? money(str(form, 'costCreditsUsd').replace(/US/i, '')) : 0
  const expires = str(form, 'costCreditsExpire')
  if (!(Number.isFinite(credits) && credits >= 0 && credits <= 1_000_000)) return { error: 'Credits left is the US$ amount on AWS Billing > Credits, like 250, or empty.' }
  if (expires && !/^\d{4}-\d{2}-\d{2}$/.test(expires)) return { error: 'Pick the date the credits expire, or leave it empty.' }
  const changed = budget !== before.costBudget || currencyChanged
  const creditsChanged = credits !== before.costCreditsUsd
  saveSettings({
    costCurrency: wanted, costBudget: Math.round(budget * 100) / 100, costRate: rate, ...(changed ? { costAlertState: '' } : {}),
    // The typed balance is "as of today": credits used after today are taken off it.
    costCreditsUsd: Math.round(credits * 100) / 100, costCreditsExpire: credits ? expires : '',
    ...(creditsChanged ? { costCreditsAsOf: credits ? new Date().toISOString().slice(0, 10) : '' } : {}),
  })
  const done = budget ? `Saved. Alerts go out at 50%, 80% and 100% of ${fmtMoney(budget, wanted)}, and when the forecast goes over it.` : 'Saved. No budget set, so only spike alerts go out.'
  // A new currency needs the numbers again; a new budget is checked straight away against the ones already fetched.
  if (currencyChanged && costSource()) {
    const error = await refreshCosts('currency changed')
    revalidatePath('/admin/costs')
    return { ok: error ? `${done} AWS didn't answer, so the numbers change at the next fetch: ${error}` : done }
  }
  const snap = latestSnapshot()
  if (snap && !currencyChanged) await runCostAlerts({ ...snap, ...(rate > 0 ? { rate, rateSource: 'typed' as const } : {}) })
  revalidatePath('/admin/costs')
  return { ok: done }
}

export async function refreshCostsAction(_prev: FormState): Promise<FormState> {
  const admin = await requireOwner()
  const off = pluginOffError('aws')
  if (off) return { error: off }
  const error = await refreshCosts(admin.email)
  revalidatePath('/admin/costs')
  return error ? { error } : { ok: 'Costs refreshed from AWS.' }
}

/** Creates the same budget in AWS Budgets, so AWS emails too (even if the deployer is down). */
export async function saveAwsBudgetAction(_prev: FormState): Promise<FormState> {
  await requireOwner()
  const off = pluginOffError('aws')
  if (off) return { error: off }
  const source = costSource()
  const s = getSettings()
  if (!source) return { error: 'Add the AWS key first.' }
  if (!(s.costBudget > 0)) return { error: 'Set a monthly budget first (Budget and alerts).' }
  const cur = costCurrency()
  const snap = latestSnapshot()
  const { rate } = cur === 'USD' ? { rate: 1 } : s.costRate > 0 ? { rate: s.costRate } : snap && snap.currency === cur ? snap : await displayRate()
  // AWS Budgets only takes US$: the budget at today's rate.
  const usd = Math.round((s.costBudget / rate) * 100) / 100
  const emails = alertRecipients()
  if (!emails.length) return { error: 'Nobody to email: add addresses under Monitoring > Alerts.' }
  try {
    await source.saveBudget(usd, emails)
  } catch (err) {
    return { error: `AWS didn't save the budget: ${awsErrorText(err)}` }
  }
  return { ok: `AWS budget saved: US$${usd.toFixed(2)} a month${cur === 'USD' ? '' : ` (${fmtMoney(s.costBudget, cur)} at ${rate.toFixed(4)})`}. AWS emails ${emails.join(', ')} at 80% and 100% actual, and when its forecast goes over.` }
}
