import Link from 'next/link'
import { requireOwner, requirePlugin } from '@/lib/guards'
import { listClubs, listServers } from '@/lib/clubs'
import { mailReady } from '@/lib/mail'
import { alertRecipients } from '@/lib/monitor'
import { displayLocale, getSettings } from '@/lib/settings'
import { bucketUsage, clubNs } from '@/lib/backups/records'
import { BUDGET_NAME, IAM_POLICY, costSource } from '@/plugins/aws/costs/aws'
import { currentEstimate } from '@/plugins/aws/costs/estimate'
import { ACTUAL_LEVELS, creditSummary, isSpike, summarise } from '@/plugins/aws/costs/report'
import { costCurrency, lastAttempt, latestSnapshot, moneyFormatter, typedCredits } from '@/plugins/aws/costs/service'
import { CURRENCIES, currencySymbol } from '@/plugins/aws/money'
import type { Snapshot } from '@/plugins/aws/costs/report'
import { isFakeEngine } from '@/lib/engine'
import { ActionForm } from '@/components/ActionForm'
import { ActionButton, Popup, Toolbar } from '@/components/Popup'
import { fmtTime } from '@/components/ui'
import { saveAwsBudgetAction, saveBudgetAction, saveCostKeyAction, refreshCostsAction } from './actions'

export const metadata = { title: 'Costs' }
export const dynamic = 'force-dynamic'

const monthName = (ym: string, short = false) => new Intl.DateTimeFormat(displayLocale(), { month: short ? 'short' : 'long', year: short ? undefined : 'numeric', timeZone: 'UTC' }).format(new Date(`${ym}-01T00:00:00Z`))
const dayName = (d: string) => new Intl.DateTimeFormat(displayLocale(), { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`))
const change = (cur: number, last: number) => {
  if (!last) return null
  const pct = Math.round(((cur - last) / last) * 100)
  return pct === 0 ? 'same as last month' : `${pct > 0 ? '+' : ''}${pct}% on last month`
}

/** Bars, one series. Hover a bar for its value (title). The last bar can be marked as still counting. */
function Bars({ rows, partialLast, line, label, width = 640 }: { rows: { key: string; label: string; amount: number }[]; partialLast?: boolean; line?: { amount: number; label: string }; label: string; width?: number }) {
  const fmtMoney = moneyFormatter()
  if (!rows.length) return null
  const W = width, H = 160, top = 14, bottom = 22, gap = 2
  const max = Math.max(...rows.map((r) => r.amount), line?.amount ?? 0, 0.01) * 1.1
  const bw = W / rows.length
  const y = (v: number) => top + (H - top - bottom) * (1 - v / max)
  const base = H - bottom
  const every = Math.ceil(rows.length / 8)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={label} style={{ display: 'block' }}>
      <line x1={0} x2={W} y1={base} y2={base} stroke="var(--line-2, var(--line))" strokeWidth={1} />
      {rows.map((r, i) => {
        const h = Math.max(0, base - y(Math.max(0, r.amount)))
        const x = i * bw + gap / 2
        const w = Math.max(1, bw - gap)
        const rad = Math.min(4, w / 2, h)
        const partial = partialLast && i === rows.length - 1
        return (
          <g key={r.key}>
            <title>{`${r.label}: ${fmtMoney(r.amount)}${partial ? ' so far' : ''}`}</title>
            <rect x={i * bw} y={top} width={bw} height={base - top} fill="transparent" />
            {h > 0 && <path d={`M${x},${base} V${base - h + rad} Q${x},${base - h} ${x + rad},${base - h} H${x + w - rad} Q${x + w},${base - h} ${x + w},${base - h + rad} V${base} Z`}
              fill="var(--accent)" opacity={partial ? 0.4 : 1} />}
            {i % every === 0 && <text x={i * bw + bw / 2} y={H - 6} textAnchor="middle" fontSize={10} fill="var(--muted)">{r.label}</text>}
          </g>
        )
      })}
      {line && line.amount > 0 && <>
        <line x1={0} x2={W} y1={y(line.amount)} y2={y(line.amount)} stroke="var(--muted)" strokeWidth={1} strokeDasharray="4 3" />
        <text x={W - 2} y={y(line.amount) - 4} textAnchor="end" fontSize={10} fill="var(--muted)">{line.label}</text>
      </>}
    </svg>
  )
}

/** "In A$ at 1.5400 per US$ (day's rate, 26 Nov)", or "In US$, as AWS bills". */
function rateLine(snap: Snapshot | null) {
  const cur = snap?.currency ?? costCurrency()
  const name = CURRENCIES.find((c) => c.code === cur)?.symbol ?? cur
  if (cur === 'USD') return snap?.rateSource === 'fallback' && costCurrency() !== 'USD'
    ? <>In US$: the rate service was out of reach, so the numbers aren&apos;t converted until the next fetch.</>
    : <>In US$, as AWS bills.</>
  if (!snap) return <>In {name} at the day&apos;s rate.</>
  const why = snap.rateSource === 'typed' ? 'your rate' : snap.rateSource === 'daily' ? `day's rate${snap.rateDate ? `, ${dayName(snap.rateDate)}` : ''}` : snap.rateSource === 'last known' ? 'last known rate' : 'a stand-in rate: the rate service was out of reach'
  return <>In {name} at {snap.rate.toFixed(4)} per US$ ({why}).</>
}

export default async function CostsPage() {
  await requireOwner()
  requirePlugin('aws')
  const s = getSettings()
  const configured = !!costSource()
  const snap = latestSnapshot()
  const attempt = lastAttempt()
  const sum = snap ? summarise(snap, new Date()) : null
  const cr = snap ? creditSummary(snap, new Date(), typedCredits()) : null
  const creditsSoon = !!(cr?.runsOut && cr.left && new Date(`${cr.runsOut}T00:00:00Z`).getTime() - Date.now() <= 30 * 86_400_000)
  const cur = costCurrency()
  const sym = currencySymbol(cur)
  // The budget is in the chosen currency; numbers fetched in another one aren't compared with it.
  const budget = !sum || sum.currency === cur ? s.costBudget : 0
  const fmtMoney = moneyFormatter(sum?.currency ?? cur)
  const usage = bucketUsage()
  const clubs = listClubs()
  const servers = listServers()
  const estimate = currentEstimate()
  const alloc = estimate?.alloc ?? null
  const pctUsed = budget > 0 && sum ? Math.round((sum.monthToDate / budget) * 100) : null
  const forecastOver = budget > 0 && sum ? sum.forecast > budget : false
  const policy = IAM_POLICY

  return (
    <>
      <div className="page-head">
        <div><h1>Costs</h1>
          <p className="muted">What AWS charges for the deployer, the sites servers and the backup bucket, from Cost Explorer once a day. {rateLine(snap)}</p></div>
        <Toolbar>
          {configured && <ActionButton action={refreshCostsAction} label="Refresh now" short="Refresh" busy="Asking AWS…" icon="refresh" />}
          {configured && budget > 0 && <ActionButton action={saveAwsBudgetAction} label="Save as AWS budget" short="AWS budget" busy="Saving…" icon="bell" />}
          <Popup label="Budget and alerts" short="Budget" icon="sliders" subtitle={<>Emails go to the Monitoring alert people ({alertRecipients().join(', ') || 'every admin'}) at {ACTUAL_LEVELS.join('%, ')}% of the budget, when the forecast goes over it, and when one day costs more than twice the week before.</>}>
            {!mailReady() && <div className="notice warn">Outgoing email isn&apos;t set up yet (<Link href="/admin/settings">Settings</Link>), so the deployer can&apos;t send these. Press <strong>Save as AWS budget</strong> after saving to have AWS email you instead.</div>}
            <ActionForm action={saveBudgetAction} submit="Save" busy="Saving…">
              <div className="grid cols-2">
                <div className="field"><label htmlFor="costCurrency">Show money in</label>
                  <select id="costCurrency" name="costCurrency" defaultValue={cur}>{CURRENCIES.map((c) => <option key={c.code} value={c.code}>{c.symbol} · {c.name}</option>)}</select>
                  <div className="help">AWS bills in US$. Another currency is converted at the day&apos;s rate. Changing it fetches the numbers again.</div></div>
                <div className="field"><label htmlFor="costBudget">Monthly budget ({sym})</label><input id="costBudget" name="costBudget" type="text" inputMode="decimal" defaultValue={s.costBudget || ''} placeholder="150" style={{ maxWidth: 160 }} /><div className="help">Empty = no budget (spike alerts only). Check it after changing the currency.</div></div>
                {cur !== 'USD' && <div className="field"><label htmlFor="costRate">{sym} per US$</label><input id="costRate" name="costRate" type="text" inputMode="decimal" defaultValue={s.costRate || ''} placeholder="the day's rate" style={{ maxWidth: 160 }} /><div className="help">Leave empty for the day&apos;s rate (European Central Bank). Or type the rate on your AWS invoice.</div></div>}
              </div>
              <h3 style={{ marginTop: 8 }}>Promotional credits</h3>
              <p className="help" style={{ marginTop: 0 }}>AWS shows credits used, but has no way to read how much of a credit code (AWS Activate, a promotion) is left. Copy it from AWS Billing &gt; <strong>Credits</strong>; credits used from today on are taken off it. Not needed for the AWS free plan, which is read by itself.</p>
              <div className="grid cols-2">
                <div className="field"><label htmlFor="costCreditsUsd">Credits left (US$)</label><input id="costCreditsUsd" name="costCreditsUsd" type="text" inputMode="decimal" defaultValue={s.costCreditsUsd || ''} placeholder="none" style={{ maxWidth: 160 }} /><div className="help">{s.costCreditsUsd ? `Typed on ${s.costCreditsAsOf}. Change it to type today's balance.` : 'AWS credits are in US$.'}</div></div>
                <div className="field"><label htmlFor="costCreditsExpire">They expire on</label><input id="costCreditsExpire" name="costCreditsExpire" type="date" defaultValue={s.costCreditsExpire} style={{ maxWidth: 180 }} /></div>
              </div>
            </ActionForm>
          </Popup>
          <Popup label={configured && !isFakeEngine() ? 'AWS key' : 'Connect AWS'} short="AWS key" icon="key" primary={!configured} panel subtitle="A read-only key for Cost Explorer and the Lightsail plan list. It can't change or start anything, apart from the one AWS budget the deployer keeps.">
            <ol className="small" style={{ paddingLeft: 18, marginTop: 0 }}>
              <li>In the AWS console, Billing &gt; <strong>Cost Explorer</strong>: turn it on if it isn&apos;t (the first numbers take up to a day).</li>
              <li>Account &gt; <strong>IAM user and role access to Billing information</strong>: turn it on.</li>
              <li>IAM &gt; Users &gt; <strong>Create user</strong> (for example <code>avro-costs</code>, no console access). Add the policy below as an inline policy.</li>
              <li>On the user, Security credentials &gt; <strong>Create access key</strong> (&quot;Application running outside AWS&quot;), and paste both parts here.</li>
            </ol>
            <pre className="mono small" style={{ background: 'var(--surface-2)', padding: '10px 12px', borderRadius: 8, overflowX: 'auto', maxHeight: 220 }}>{policy}</pre>
            <ActionForm action={saveCostKeyAction} submit="Save and fetch" busy="Asking AWS…">
              <div className="grid cols-2">
                <div className="field"><label htmlFor="costAccessKeyId">Access key ID</label><input id="costAccessKeyId" name="costAccessKeyId" type="text" defaultValue={s.costAccessKeyId} autoComplete="off" spellCheck={false} autoCapitalize="characters" /><div className="help">Empty it and save to disconnect.</div></div>
                <div className="field"><label htmlFor="costSecretAccessKey">Secret access key</label><input id="costSecretAccessKey" name="costSecretAccessKey" type="password" autoComplete="new-password" placeholder={s.costSecretAccessKey ? 'Saved. Type to replace' : ''} /></div>
                <div className="field"><label htmlFor="costRegion">Lightsail region</label><input id="costRegion" name="costRegion" type="text" defaultValue={s.costRegion} /><div className="help">Sydney is <code>ap-southeast-2</code>.</div></div>
              </div>
              <p className="help">The bucket&apos;s own access key (Backups) can&apos;t be used: Lightsail bucket keys only open that bucket. Cost Explorer charges US$0.01 per question; a fetch asks 4, once a day (about US$1.20 a month).</p>
            </ActionForm>
          </Popup>
        </Toolbar>
      </div>

      {!configured && <div className="notice warn">Not connected yet. Press <strong>Connect AWS</strong>, create the read-only key it describes, and paste it in.</div>}
      {attempt && !attempt.ok && <div className="notice bad">The last fetch ({fmtTime(attempt.fetchedAt)}) failed: {attempt.error}{snap ? ' The numbers below are from the last good one.' : ''}</div>}
      {configured && !snap && !attempt && <div className="notice">No numbers yet. Press <strong>Refresh now</strong>.</div>}
      {isFakeEngine() && !s.costAccessKeyId && <div className="notice">Practice mode: these are made-up numbers in the shape AWS sends.</div>}

      {sum && snap && (
        <>
          {creditsSoon && cr && <div className="notice warn">AWS credits {cr.runsOutWhy === 'expires' ? `expire on ${dayName(cr.runsOut!)}` : `run out around ${dayName(cr.runsOut!)}`} ({fmtMoney(cr.left!)} left). After that you pay the full charges: about {fmtMoney(cr.chargesForecast)} a month at the current rate.</div>}
          {(forecastOver || (pctUsed !== null && pctUsed >= 80) || isSpike(sum.lastDay, sum.spikeMin)) && (
            <div className={`notice ${pctUsed !== null && pctUsed >= 100 ? 'bad' : 'warn'}`}>
              {pctUsed !== null && pctUsed >= 100 ? `Over budget: ${fmtMoney(sum.monthToDate)} of ${fmtMoney(budget)} so far this month.`
                : pctUsed !== null && pctUsed >= 80 ? `${pctUsed}% of the budget is used so far this month.`
                : forecastOver ? `Heading over budget: the forecast is ${fmtMoney(sum.forecast)} against ${fmtMoney(budget)}.` : ''}
              {isSpike(sum.lastDay, sum.spikeMin) && sum.lastDay && ` Spend jumped on ${dayName(sum.lastDay.day)}: ${fmtMoney(sum.lastDay.amount)} against ${fmtMoney(sum.lastDay.averageBefore)} a day the week before.`}
            </div>
          )}

          <div className="grid cols-3" style={{ marginBottom: 16 }}>
            <div className="card" style={{ marginBottom: 0 }}><div className="stat">{fmtMoney(sum.monthToDate)}</div><div className="stat-label">you pay for {monthName(sum.month)} so far{cr && cr.thisMonth.credits + cr.thisMonth.discounts > 0 ? `: ${fmtMoney(cr.thisMonth.charges)} charged, ${fmtMoney(cr.thisMonth.credits + cr.thisMonth.discounts)} covered by credits` : ''}{pctUsed !== null ? `. ${pctUsed}% of the budget` : ''}</div></div>
            <div className="card" style={{ marginBottom: 0 }}><div className="stat" style={forecastOver ? { color: 'var(--bad)' } : undefined}>{fmtMoney(sum.forecast)}</div><div className="stat-label">you&apos;ll pay this month (forecast{sum.forecastFrom === 'estimate' ? ', straight-line: AWS has too little history' : ''}){cr && cr.chargesForecast - sum.forecast >= 0.5 ? `. Without credits: ${fmtMoney(cr.chargesForecast)}` : ''}{budget > 0 ? `. Budget ${fmtMoney(budget)}` : ''}</div></div>
            <div className="card" style={{ marginBottom: 0 }}><div className="stat">{fmtMoney(sum.lastMonth)}</div><div className="stat-label">you paid last month{cr && cr.lastMonth.credits + cr.lastMonth.discounts > 0 ? `, after ${fmtMoney(cr.lastMonth.credits + cr.lastMonth.discounts)} of credits` : ''}{change(sum.forecast, sum.lastMonth) ? ` (forecast ${change(sum.forecast, sum.lastMonth)})` : ''}</div></div>
            {cr && cr.left !== null
              ? <div className="card" style={{ marginBottom: 0 }}><div className="stat" style={creditsSoon ? { color: 'var(--warn)' } : undefined}>{fmtMoney(cr.left)}</div><div className="stat-label">credits left{cr.runsOut ? `, ${cr.runsOutWhy === 'expires' ? 'expire' : 'last until about'} ${dayName(cr.runsOut)} ${cr.runsOut.slice(0, 4)}` : ''}</div></div>
              : <div className="card" style={{ marginBottom: 0 }}><div className="stat">{alloc ? fmtMoney(alloc.planTotal) : '–'}</div><div className="stat-label">a month at Lightsail plan prices ({snap.resources.filter((r) => r.kind === 'instance').length} VMs, {snap.resources.filter((r) => r.kind === 'bucket').length} bucket)</div></div>}
          </div>
          {budget > 0 && pctUsed !== null && <div className={`bar${pctUsed >= 100 ? ' high' : ''}`} style={{ marginBottom: 16 }} title={`${pctUsed}% of the budget`}><span style={{ width: `${Math.min(100, pctUsed)}%` }} /></div>}

          {cr && !cr.none && (
            <div className="card">
              <h2>Credits and free tier</h2>
              <div className="grid cols-2">
                <div>
                  {cr.left !== null ? (
                    <p style={{ marginTop: 0 }}><strong>{fmtMoney(cr.left)}</strong> of credits left{cr.leftFrom === 'aws free plan' ? ' on the AWS free plan (read from AWS)' : ` (typed on ${cr.leftAsOf}, less credits used since)`}.
                      {cr.usePerDay > 0 && <> Used at about {fmtMoney(cr.usePerDay)} a day.</>}
                      {cr.runsOut && <> {cr.runsOutWhy === 'expires' ? `They expire on ${dayName(cr.runsOut)} ${cr.runsOut.slice(0, 4)}` : `At that pace they last until about ${dayName(cr.runsOut)} ${cr.runsOut.slice(0, 4)}`}{cr.expires && cr.runsOutWhy !== 'expires' ? ` (expiry ${cr.expires})` : ''}.</>}
                      {' '}After that, AWS charges about <strong>{fmtMoney(cr.chargesForecast)}</strong> a month at the current rate.</p>
                  ) : (
                    <p className="muted small" style={{ marginTop: 0 }}>How much credit is left isn&apos;t known: AWS can&apos;t report what is left of a credit code. Type it under <strong>Budget and alerts</strong> to see how long it lasts.</p>
                  )}
                  <div className="table-wrap"><table>
                    <thead><tr><th>Month</th><th style={{ textAlign: 'right' }}>Charges</th><th style={{ textAlign: 'right' }}>Credits</th><th style={{ textAlign: 'right' }}>You paid</th></tr></thead>
                    <tbody>{[...cr.months].reverse().map((m) => (
                      <tr key={m.month}><td>{monthName(m.month, true)} {m.month.slice(0, 4)}{m.month === sum.month ? <span className="muted small"> so far</span> : null}</td>
                        <td style={{ textAlign: 'right' }}>{fmtMoney(m.charges)}</td>
                        <td className="muted" style={{ textAlign: 'right' }}>{m.credits + m.discounts > 0 ? `−${fmtMoney(m.credits + m.discounts)}` : '–'}</td>
                        <td style={{ textAlign: 'right' }}><strong>{fmtMoney(m.pay)}</strong></td></tr>
                    ))}</tbody>
                  </table></div>
                </div>
                <div>
                  <h3 style={{ marginTop: 0 }}>Free tier this month</h3>
                  {cr.freeTier.length ? (
                    <div className="table-wrap"><table>
                      <thead><tr><th>What</th><th style={{ textAlign: 'right' }}>Used of free</th></tr></thead>
                      <tbody>{cr.freeTier.slice(0, 12).map((f, i) => (
                        <tr key={i}><td>{f.service}<div className="muted small">{f.description}</div>{f.over && <span className="badge warn">{f.actual > f.limit ? 'over: the rest is charged' : 'heading over this month'}</span>}</td>
                          <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{+f.actual.toFixed(2)} of {+f.limit.toFixed(2)} {f.unit}<div className="muted small">{f.pct}%</div></td></tr>
                      ))}</tbody>
                    </table></div>
                  ) : <p className="muted small">Nothing is using the free tier this month.</p>}
                </div>
              </div>
              {cr.errors.length > 0 && <p className="help">Not read: {cr.errors.join(' ')}</p>}
            </div>
          )}

          <div className="card">
            <h2>What you pay each day, last 31 days</h2>
            <Bars label="AWS spend per day" width={900} partialLast rows={sum.daily.map((d) => ({ key: d.day, label: dayName(d.day), amount: d.amount }))} />
            <p className="help">Days are UTC, as AWS counts them. Today (paler) is still counting; AWS updates its numbers a few times a day.</p>
          </div>

          <div className="grid cols-2">
            <div className="card">
              <h2>By AWS service <span className="muted small" style={{ fontWeight: 400 }}>after credits</span></h2>
              <div className="table-wrap"><table>
                <thead><tr><th>Service</th><th style={{ textAlign: 'right' }}>{monthName(sum.month, true)} so far</th><th style={{ textAlign: 'right' }}>Last month</th></tr></thead>
                <tbody>{sum.services.map((l) => <tr key={l.name}><td>{l.name}</td><td style={{ textAlign: 'right' }}>{fmtMoney(l.amount)}</td><td className="muted" style={{ textAlign: 'right' }}>{fmtMoney(l.lastAmount)}</td></tr>)}
                  {!sum.services.length && <tr><td colSpan={3} className="muted">Nothing charged yet this month.</td></tr>}</tbody>
              </table></div>
            </div>
            <div className="card">
              <h2>Lightsail</h2>
              <div className="table-wrap"><table>
                <thead><tr><th>Part</th><th style={{ textAlign: 'right' }}>{monthName(sum.month, true)} so far</th><th style={{ textAlign: 'right' }}>Last month</th></tr></thead>
                <tbody>{sum.lightsail.map((l) => <tr key={l.name}><td>{l.name}</td><td style={{ textAlign: 'right' }}>{fmtMoney(l.amount)}</td><td className="muted" style={{ textAlign: 'right' }}>{fmtMoney(l.lastAmount)}</td></tr>)}
                  {!sum.lightsail.length && <tr><td colSpan={3} className="muted">No Lightsail charges yet.</td></tr>}</tbody>
              </table></div>
            </div>
          </div>

          {estimate && estimate.projects.length > 0 && (
            <div className="card">
              <h2>Each project, a month (estimate)</h2>
              <p className="muted small" style={{ marginTop: 0 }}>Its services&apos; shares below added up. The deployer and AI share is split evenly between projects with something running, not per service.</p>
              <div className="table-wrap"><table>
                <thead><tr><th>Project</th><th style={{ textAlign: 'right' }}>Services</th><th style={{ textAlign: 'right' }}>VM share</th><th style={{ textAlign: 'right' }}>Backups</th><th style={{ textAlign: 'right' }}>Deployer and AI</th><th style={{ textAlign: 'right' }}>Total</th></tr></thead>
                <tbody>{estimate.projects.map((p) => (
                  <tr key={p.id}>
                    <td><Link href={`/admin/projects/${p.id}`}>{p.name}</Link></td>
                    <td style={{ textAlign: 'right' }}>{p.services}</td>
                    <td style={{ textAlign: 'right' }}>{fmtMoney(p.vm)}</td><td style={{ textAlign: 'right' }}>{fmtMoney(p.bucket)}</td><td style={{ textAlign: 'right' }}>{fmtMoney(p.shared)}</td>
                    <td style={{ textAlign: 'right' }}><strong>{fmtMoney(p.total)}</strong></td>
                  </tr>
                ))}</tbody>
              </table></div>
            </div>
          )}

          <div className="card">
            <h2>Each site, a month (estimate)</h2>
            <p className="muted small" style={{ marginTop: 0 }}>The sites share VMs, so AWS can&apos;t split the bill by site. This splits the plan prices: each server&apos;s VM by the memory of the running sites on it, the bucket by each site&apos;s backup size, and the other VMs (the deployer, with the AI assistant) evenly between running sites. Paused sites only pay for their backups.</p>
            {alloc && alloc.unmatched.length > 0 && <div className="notice warn">No Lightsail VM found for {alloc.unmatched.map((v) => v.name).join(', ')}: its public IP under <Link href="/admin/servers">Servers</Link> doesn&apos;t match any VM in {s.costRegion}. Its sites show no VM share.</div>}
            <div className="table-wrap"><table>
              <thead><tr><th>Site</th><th>Server</th><th style={{ textAlign: 'right' }}>VM share</th><th style={{ textAlign: 'right' }}>Backups</th><th style={{ textAlign: 'right' }}>Deployer and AI</th><th style={{ textAlign: 'right' }}>Total</th></tr></thead>
              <tbody>{alloc?.sites.map((c) => (
                <tr key={c.id}>
                  <td><Link href={`/admin/clubs/${c.id}`}>{c.displayName}</Link> <span className="muted small mono">{c.name}</span></td>
                  <td className="muted">{c.server}</td>
                  <td style={{ textAlign: 'right' }}>{fmtMoney(c.vm)}</td><td style={{ textAlign: 'right' }}>{fmtMoney(c.bucket)}</td><td style={{ textAlign: 'right' }}>{fmtMoney(c.shared)}</td>
                  <td style={{ textAlign: 'right' }}><strong>{fmtMoney(c.total)}</strong></td>
                </tr>
              ))}
                {!alloc?.sites.length && <tr><td colSpan={6} className="muted">No sites yet.</td></tr>}</tbody>
            </table></div>
          </div>

          <div className="grid cols-2">
            <div className="card">
              <h2>Lightsail plans</h2>
              <div className="table-wrap"><table>
                <thead><tr><th>Name</th><th>Plan</th><th>Used for</th><th style={{ textAlign: 'right' }}>A month</th></tr></thead>
                <tbody>{snap.resources.map((r) => {
                  const server = alloc ? [...alloc.serverVm.entries()].find(([, vm]) => vm === r || (vm.name === r.name && vm.kind === r.kind)) : undefined
                  const used = r.kind === 'bucket' ? 'Backups' : server ? `Server ${servers.find((v) => v.id === server[0])?.name ?? ''}` : 'Deployer, AI, other'
                  return <tr key={`${r.kind}:${r.name}`}><td className="mono small">{r.name}{r.state && !/^(running|ok)$/i.test(r.state) ? <span className="badge warn" style={{ marginLeft: 6 }}>{r.state}</span> : null}</td><td className="muted">{r.plan}</td><td className="muted">{used}</td><td style={{ textAlign: 'right' }}>{fmtMoney(r.monthlyUsd * snap.rate)}</td></tr>
                })}</tbody>
              </table></div>
            </div>
            <div className="card">
              <h2>Each month</h2>
              <Bars label="AWS spend per month" width={440} partialLast rows={sum.monthly.map((m) => ({ key: m.month, label: monthName(m.month, true), amount: m.amount }))} line={budget > 0 ? { amount: budget, label: `budget ${fmtMoney(budget)}` } : undefined} />
              <p className="help">Earlier months at this snapshot&apos;s rate. This month (paler) is so far.</p>
            </div>
          </div>

          <p className="help">Fetched {fmtTime(snap.fetchedAt)}{attempt?.ok && attempt.by !== 'schedule' ? ` by ${attempt.by}` : ''}, next one about a day later. AWS bills in US$; amounts here include GST where AWS charges it (the &quot;Tax&quot; line). {budget > 0 && <>The AWS budget is called <code>{BUDGET_NAME}</code>.</>}</p>
        </>
      )}
    </>
  )
}
