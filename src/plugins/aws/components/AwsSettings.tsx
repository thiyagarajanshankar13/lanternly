import Link from 'next/link'
import { displayLocale, getSettings } from '@/lib/settings'
import { CURRENCIES, currencyOf, fmtMoney } from '../money'

/** Settings › Plugins › Amazon Web Services: where its keys and choices are. */
export function AwsSettings() {
  const s = getSettings()
  return (
    <div className="card">
      <h2>Keys and choices</h2>
      <dl className="summary">
        <dt>Making servers (Lightsail)</dt><dd>{s.provisionAccessKeyId ? `Key saved · ${s.provisionRegion} (${s.provisionZone})` : 'No key yet'} · <Link href="/admin/servers">Servers › AWS for new servers</Link></dd>
        <dt>Reading costs</dt><dd>{s.costAccessKeyId ? `Key saved · ${s.costRegion}` : 'No key yet'} · <Link href="/admin/costs">Costs</Link></dd>
        <dt>Money shown in</dt><dd>{CURRENCIES.find((c) => c.code === currencyOf(s.costCurrency))?.name} · <Link href="/admin/costs">Costs › Budget and alerts</Link></dd>
        <dt>Monthly budget</dt><dd>{s.costBudget > 0 ? fmtMoney(s.costBudget, currencyOf(s.costCurrency), displayLocale()) : 'None'}</dd>
      </dl>
      <p className="muted small" style={{ marginBottom: 0 }}>Backups don&apos;t need this plugin: they work with any S3-style bucket, set on the Backups page.</p>
    </div>
  )
}
