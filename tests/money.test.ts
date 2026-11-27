import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MIGRATIONS, resetDbForTests } from '@/lib/db'
import { getSettings, saveSettings } from '@/lib/settings'
import { FakeCostSource, setCostSourceForTests } from '@/plugins/aws/costs/aws'
import { summarise } from '@/plugins/aws/costs/report'
import { displayRate, latestSnapshot, normaliseSnapshot, refreshCosts, setRateFetcherForTests } from '@/plugins/aws/costs/service'
import { CURRENCIES, currencyOf, fmtMoney } from '@/plugins/aws/money'
import { budgetCheck, priceText } from '@/plugins/aws/provision/plan'
import { projectCosts } from '@/plugins/server'
import { setPluginOn } from '@/plugins'
import { freshEnv } from './setup'

// Phase 4 of the generic deployer: the AWS plugin shows money in any currency.

const TODAY = new Date('2026-11-24T03:00:00Z')

describe('formatting money', () => {
  it('writes the symbol, then two decimals in the locale', () => {
    expect(fmtMoney(1234.5, 'AUD', 'en-AU')).toBe('A$1,234.50')
    expect(fmtMoney(12, 'USD')).toBe('US$12.00')
    expect(fmtMoney(1234.5, 'EUR', 'de-DE')).toBe('€1.234,50')
    expect(priceText(44, 1.5, 'AUD', 'en-AU')).toBe('A$66.00')
    expect(budgetCheck({ currentUsd: 10, addUsd: 10, rate: 1, budget: 15, currency: 'USD' }).text).toContain('Budget US$15.00')
  })
  it('treats an unknown setting as US$', () => {
    expect(currencyOf('XYZ')).toBe('USD')
    expect(currencyOf('NZD')).toBe('NZD')
    expect(new Set(CURRENCIES.map((c) => c.code)).size).toBe(CURRENCIES.length)
  })
})

describe('the rate', () => {
  let asked: string[] = []
  beforeEach(() => {
    freshEnv()
    asked = []
    setRateFetcherForTests(async (cur) => { asked.push(cur); return { rate: 0.92, date: '2026-11-23' } })
  })
  afterEach(() => { setRateFetcherForTests(undefined); setCostSourceForTests(undefined) })

  it('a fresh install shows US$ and asks for no rate', async () => {
    expect(getSettings().costCurrency).toBe('USD')
    expect(await displayRate()).toEqual({ currency: 'USD', rate: 1, rateSource: 'none', rateDate: '' })
    expect(asked).toEqual([])
  })
  it('asks for the chosen currency', async () => {
    saveSettings({ costCurrency: 'EUR' })
    expect(await displayRate()).toMatchObject({ currency: 'EUR', rate: 0.92, rateSource: 'daily' })
    expect(asked).toEqual(['EUR'])
  })
  it('falls back to US$ for a currency with no rate at all, and to 1.55 for A$', async () => {
    setRateFetcherForTests(async () => { throw new Error('offline') })
    saveSettings({ costCurrency: 'EUR' })
    expect(await displayRate()).toMatchObject({ currency: 'USD', rate: 1, rateSource: 'fallback' })
    saveSettings({ costCurrency: 'AUD' })
    expect(await displayRate()).toMatchObject({ currency: 'AUD', rate: 1.55, rateSource: 'fallback' })
  })
  it('keeps the currency with each snapshot and estimates projects in it', async () => {
    setCostSourceForTests(new FakeCostSource({ dailyUsd: 2 }))
    saveSettings({ costCurrency: 'GBP' })
    expect(await refreshCosts('test', TODAY)).toBeNull()
    const snap = latestSnapshot()!
    expect(snap).toMatchObject({ currency: 'GBP', rate: 0.92 })
    expect(summarise(snap, TODAY).currency).toBe('GBP')
    setPluginOn('aws', true)
    for (const text of projectCosts().values()) expect(text).toMatch(/^£/)
    setPluginOn('aws', false)
    expect(projectCosts().size).toBe(0)
  })
})

describe('an install from before the currency setting', () => {
  it('reads old snapshots (usdToAud) as A$', () => {
    const old = { fetchedAt: TODAY.toISOString(), raw: { monthly: [], daily: [], lightsail: [], forecastRest: 0 }, resources: [], usdToAud: 1.52, rateSource: 'daily', rateDate: '2026-11-20' }
    expect(normaliseSnapshot(old as never)).toMatchObject({ currency: 'AUD', rate: 1.52 })
    expect(normaliseSnapshot(old as never)).not.toHaveProperty('usdToAud')
  })

  const CURRENCY_MIGRATION = MIGRATIONS.findIndex((m) => m.includes("SELECT 'costCurrency', 'AUD'"))
  function upgradeFrom(seed: (old: Database.Database) => void) {
    const dir = freshEnv()
    resetDbForTests()
    const old = new Database(path.join(dir, 'deployer.sqlite'))
    for (let i = 0; i < CURRENCY_MIGRATION; i++) old.exec(MIGRATIONS[i])
    old.pragma(`user_version = ${CURRENCY_MIGRATION}`)
    seed(old)
    old.close()
    return getSettings()
  }
  it('keeps A$, the budget and the typed rate', () => {
    expect(CURRENCY_MIGRATION).toBeGreaterThan(0)
    const s = upgradeFrom((old) => {
      old.prepare("INSERT INTO admins (email, password_hash, created_at) VALUES ('o@example.com', 'x', '2026-01-01')").run()
      old.prepare("INSERT INTO settings (key, value) VALUES ('costBudgetAud', '150'), ('costAudRate', '1.54')").run()
    })
    expect(s).toMatchObject({ costCurrency: 'AUD', costBudget: 150, costRate: 1.54 })
  })
  it('starts in US$ when nobody has used it yet', () => {
    expect(upgradeFrom(() => {}).costCurrency).toBe('USD')
  })
})
