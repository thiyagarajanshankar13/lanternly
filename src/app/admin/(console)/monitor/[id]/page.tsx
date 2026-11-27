import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getClub } from '@/lib/clubs'
import { requireAdmin } from '@/lib/auth'
import { canSeeSite, isOwner } from '@/lib/access'
import { randomToken } from '@/lib/crypto'
import { isBehind, isChecked, latestVersion, listStatsDays, getWatched, listChecks, uptime } from '@/lib/monitor'
import { ActionForm } from '@/components/ActionForm'
import { AutoRefresh } from '@/components/AutoRefresh'
import { SubmitButton } from '@/components/SubmitButton'
import { Icon } from '@/components/Icon'
import { Popup, Toolbar } from '@/components/Popup'
import { fmtTime } from '@/components/ui'
import { labelsBySite, listLabels } from '@/lib/monitorLabels'
import { checkNowAction, removeWatchedAction, saveWatchedAction } from '../actions'
import { LabelPicker } from '../labels'
import { ago, CertCell, StatusBadge } from '../shared'

export const dynamic = 'force-dynamic'

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin()
  const site = getWatched(Number((await params).id))
  return { title: site && (isOwner(admin) || canSeeSite(admin, site.clubId)) ? site.name : 'Monitoring' }
}

export default async function WatchedSitePage({ params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin()
  const site = getWatched(Number((await params).id))
  if (!site || !(isOwner(admin) || canSeeSite(admin, site.clubId))) notFound()
  const owner = isOwner(admin)
  const club = site.clubId !== null ? getClub(site.clubId) : null
  const on = isChecked(site)
  const latest = await latestVersion()
  const suggestedKey = randomToken(24)
  const day = uptime(site.id, 24)
  const week = uptime(site.id, 24 * 7)
  const checks = listChecks(site.id, 60)
  const strip = [...checks].reverse()
  const days = listStatsDays(site.id, 30)
  const num = (n: number | null) => (n === null ? '–' : n.toLocaleString('en'))
  const maxMs = Math.max(1, ...strip.map((c) => c.ms ?? 0))
  const labels = listLabels()
  const mine = (labelsBySite().get(site.id) ?? []).map((id) => labels.find((l) => l.id === id)).filter((l) => !!l)
  return (
    <>
      <AutoRefresh seconds={30} />
      <div className="page-head">
        <div>
          <p className="muted small" style={{ margin: 0 }}><Link href="/admin/monitor">Monitoring</Link> /</p>
          <h1>{site.name} <StatusBadge site={site} checked={on} /></h1>
          {mine.length > 0 && <div className="lbl-also" style={{ marginTop: 6 }}>{mine.map((l) => <Link key={l.id} href={`/admin/monitor?show=${l.id}`} className={`lbl lbl-${l.color}`}>{l.name}</Link>)}</div>}
          <p className="muted"><a href={site.url} target="_blank" rel="noreferrer">{site.url}</a> · {club ? <>run by this deployer (<Link href={`/admin/clubs/${club.id}`}>open the site&apos;s page</Link>)</> : 'hosted elsewhere'}</p>
        </div>
        <Toolbar>
          <form action={checkNowAction}><input type="hidden" name="id" value={site.id} /><SubmitButton busy="Checking…"><Icon name="refresh" size={16} /><span className="tb-label">Check now</span></SubmitButton></form>
          {owner && <Popup label="Settings" title="Watch settings" icon="sliders">
        <ActionForm action={saveWatchedAction} submit="Save">
          <input type="hidden" name="id" value={site.id} />
          {club ? <p className="muted">The name and address follow the site, so they can&apos;t be changed here.</p> : (
            <div className="grid cols-2">
              <div className="field"><label htmlFor="name">Name</label><input id="name" name="name" type="text" maxLength={80} defaultValue={site.name} required /></div>
              <div className="field"><label htmlFor="url">Web address</label><input id="url" name="url" type="text" defaultValue={site.url} required /></div>
            </div>
          )}
          {!club && (
            <div className="field">
              <label htmlFor="statsKey">Key for user numbers</label>
              <input id="statsKey" name="statsKey" type="password" autoComplete="new-password" className="mono" placeholder={site.hasStatsKey ? 'Saved. Type to replace' : ''} />
              <div className="help">
                Optional. On the site, add the setting <code>STATS_API_KEY</code> with a long random value (for example <code>{suggestedKey}</code>), restart it, then paste the same value here.
                The site then tells the deployer how many members and staff it has: counts only, never names. The site has to support it (Avrosphere does, from 1.3).
                {site.hasStatsKey && <> <label style={{ fontWeight: 400 }}><input type="checkbox" name="clearStatsKey" /> Remove the saved key</label></>}
              </div>
            </div>
          )}
          <LabelPicker all={labels.map((l) => ({ id: l.id, name: l.name, color: l.color, sites: l.sites }))} initial={mine.map((l) => l.name)} />
          <label className="small" style={{ fontWeight: 400 }}><input type="checkbox" name="paused" defaultChecked={site.paused} /> Pause checks and alerts for this site</label>
        </ActionForm>
        {!club && <form action={removeWatchedAction} className="danger-zone"><input type="hidden" name="id" value={site.id} /><SubmitButton className="danger">Stop watching this site</SubmitButton></form>}
          </Popup>}
        </Toolbar>
      </div>

      {on && site.lastError && <div className={`notice ${site.status === 'down' ? 'bad' : 'warn'}`}>Last check: {site.lastError}{site.status === 'down' && site.statusSince ? ` Down since ${fmtTime(site.statusSince)}.` : ''}</div>}
      {!on && <div className="notice">{site.paused ? 'Checks are paused for this site.' : 'This site is not running (paused, being created or failed), so it is not checked.'}</div>}

      <div className="grid cols-3" style={{ marginBottom: 16 }}>
        <div className="card" style={{ marginBottom: 0 }}><div className="stat">{day.percent === null ? '–' : `${day.percent}%`}</div><div className="stat-label">up, last 24 hours</div></div>
        <div className="card" style={{ marginBottom: 0 }}><div className="stat">{week.percent === null ? '–' : `${week.percent}%`}</div><div className="stat-label">up, last 7 days</div></div>
        <div className="card" style={{ marginBottom: 0 }}><div className="stat">{week.avgMs === null ? '–' : `${week.avgMs} ms`}</div><div className="stat-label">usual speed</div></div>
        <div className="card" style={{ marginBottom: 0 }}><div className="stat" style={{ fontSize: 20 }}>{site.version || '–'}{isBehind(site.version, latest) && <span className="badge warn" style={{ marginLeft: 8 }}>Behind</span>}</div><div className="stat-label">Avrosphere version{site.commit ? ` (${site.commit.slice(0, 10)})` : ''}{!site.version && site.lastCheckedAt && !site.hasHealth ? ': not reported, the site has no /api/health' : ''}</div></div>
        <div className="card" style={{ marginBottom: 0 }}><div className="stat" style={{ fontSize: 20 }}><CertCell site={site} /></div><div className="stat-label">HTTPS certificate{site.certExpiresAt ? `, until ${site.certExpiresAt.slice(0, 10)}` : ''}</div></div>
      </div>

      <div className="card">
        <h2>Users</h2>
        {site.members === null ? (
          <p className="muted" style={{ margin: 0 }}>{site.statsError || (club
            ? 'No numbers yet. They are read once an hour from sites on a version that reports them.'
            : site.hasStatsKey ? 'No numbers yet. They are read once an hour.' : 'To see how many users this site has, add a key under Settings below.')}</p>
        ) : (
          <>
            {site.statsError && <div className="notice warn">The last read failed, so these are the last numbers seen: {site.statsError}</div>}
            <div className="grid cols-3">
              <div><div className="stat">{num(site.members)}</div><div className="stat-label">members</div></div>
              <div><div className="stat">{num(site.staff)}</div><div className="stat-label">staff and admins</div></div>
              <div><div className="stat">{num(site.membersActive)}</div><div className="stat-label">members signed in, last 30 days</div></div>
              <div><div className="stat">{num(site.membersNew)}</div><div className="stat-label">new members, last 30 days</div></div>
            </div>
            <p className="muted small" style={{ marginTop: 12 }}>Counts only: the deployer never sees names or emails. Read once an hour{site.statsCheckedAt ? `, last ${ago(site.statsCheckedAt)}` : ''}.</p>
            {days.length > 1 && (
              <details>
                <summary>Day by day</summary>
                <div className="table-wrap" style={{ marginTop: 10 }}><table>
                  <thead><tr><th>Day</th><th>Members</th><th>Change</th><th>Staff</th><th>Signed in, 30 days</th></tr></thead>
                  <tbody>{days.map((d, i) => {
                    const prev = days[i + 1]
                    const change = prev ? d.members - prev.members : null
                    return (
                      <tr key={d.day}>
                        <td>{d.day}</td><td>{num(d.members)}</td>
                        <td>{change === null || change === 0 ? <span className="muted">–</span> : <span className={`badge ${change > 0 ? 'ok' : 'warn'}`}>{change > 0 ? `+${change}` : change}</span>}</td>
                        <td>{num(d.staff)}</td><td>{num(d.membersActive)}</td>
                      </tr>
                    )
                  })}</tbody>
                </table></div>
              </details>
            )}
          </>
        )}
      </div>

      <div className="card">
        <h2>Recent checks</h2>
        {checks.length === 0 ? <p className="muted" style={{ margin: 0 }}>No checks yet.</p> : (
          <>
            <div className="mon-strip" role="img" aria-label={`The last ${strip.length} checks, oldest first. ${strip.filter((c) => !c.ok).length} failed.`}>
              {strip.map((c) => <span key={c.id} className={c.ok ? '' : 'bad'} style={{ height: c.ok ? `${Math.max(18, Math.round(((c.ms ?? 0) / maxMs) * 100))}%` : '100%' }} title={`${fmtTime(c.at)}: ${c.ok ? `${c.ms} ms` : c.error}`} />)}
            </div>
            <p className="muted small">Each bar is one check, oldest on the left. Taller means slower; red means it failed. Checks are kept for 14 days.</p>
            <div className="table-wrap"><table>
              <thead><tr><th>When</th><th>Result</th><th>Speed</th><th>Version</th></tr></thead>
              <tbody>{checks.slice(0, 25).map((c) => (
                <tr key={c.id}>
                  <td>{fmtTime(c.at)} <span className="muted small">({ago(c.at)})</span></td>
                  <td className="wrap">{c.ok ? <span className="badge ok">Answered</span> : <><span className="badge bad">Failed</span> <span className="small">{c.error}</span></>}</td>
                  <td>{c.ms !== null ? `${c.ms} ms` : <span className="muted">–</span>}</td>
                  <td>{c.version || <span className="muted">–</span>}</td>
                </tr>
              ))}</tbody>
            </table></div>
          </>
        )}
      </div>

    </>
  )
}
