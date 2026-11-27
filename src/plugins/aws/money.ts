// The currency the AWS plugin shows money in. AWS bills in US$; any other
// currency is converted at the day's rate (or one an admin typed).
// Pure (no settings or network), so the Costs maths and tests can use it.

export const CURRENCIES = [
  { code: 'USD', symbol: 'US$', name: 'US dollars (as AWS bills)' },
  { code: 'AUD', symbol: 'A$', name: 'Australian dollars' },
  { code: 'NZD', symbol: 'NZ$', name: 'New Zealand dollars' },
  { code: 'CAD', symbol: 'C$', name: 'Canadian dollars' },
  { code: 'SGD', symbol: 'S$', name: 'Singapore dollars' },
  { code: 'EUR', symbol: '€', name: 'Euros' },
  { code: 'GBP', symbol: '£', name: 'British pounds' },
  { code: 'INR', symbol: '₹', name: 'Indian rupees' },
] as const

export type CurrencyCode = (typeof CURRENCIES)[number]['code']

export function isCurrency(code: unknown): code is CurrencyCode {
  return CURRENCIES.some((c) => c.code === code)
}

/** A setting's value as a currency; anything unknown is US$ (no conversion). */
export function currencyOf(code: unknown): CurrencyCode {
  return isCurrency(code) ? code : 'USD'
}

export function currencySymbol(code: CurrencyCode): string {
  return CURRENCIES.find((c) => c.code === code)?.symbol ?? 'US$'
}

/** "A$1,234.50": the symbol, then the number with two decimals in the deployer's locale. */
export function fmtMoney(n: number, code: CurrencyCode = 'USD', locale = 'en-US'): string {
  let num: string
  try { num = n.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }
  catch { num = n.toFixed(2) }
  return `${currencySymbol(code)}${num}`
}

/** The fixed rate used when no rate can be had at all (only for A$, the one currency installs had before). */
export const FALLBACK_RATES: Partial<Record<CurrencyCode, number>> = { USD: 1, AUD: 1.55 }

/** A typed rate (currency units per US$) is believable: positive and not absurd. */
export const rateOk = (rate: number) => Number.isFinite(rate) && rate > 0 && rate < 100_000
