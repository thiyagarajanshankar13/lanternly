import Link from 'next/link'
import { listClubs } from '@/lib/clubs'
import { isFakeEngine } from '@/lib/engine'
import { mailReady } from '@/lib/mail'
import { alertRecipients, isBehind, latestVersion, isChecked, listWatched, syncDeployerSites, uptime } from '@/lib/monitor'
import { getSettings } from '@/lib/settings'
import { ActionForm } from '@/components/ActionForm'
import { AutoRefresh } from '@/components/AutoRefresh'
import { SubmitButton } from '@/components/SubmitButton'
import { Icon } from '@/components/Icon'
import { Popup, Toolbar } from '@/components/Popup'
import { requireAdmin } from '@/lib/auth'
import { canSeeSite, isOwner } from '@/lib/access'
import { filterSites, groupSites, labelsBySite, listLabels, parseShow, type MonitorLabel } from '@/lib/monitorLabels'
import { addWatchedAction, checkNowAction, saveAlertSettingsAction, saveLabelsAction, saveWatchedAction } from './actions'
import { LabelChip, LabelPicker, LabelsEditor } from './labels'
import { ago, CertCell, StatusBadge } from './shared'

export const metadata = { title: 'Monitoring' }
export const dynamic = 'force-dynamic'

type Search = { view?: string; show?: string }

export default async function MonitorPage({ searchParams }: { searchParams: Promise<Search> }) {
  const admin = await requireAdmin()
  const search = await searchParams
  const owner = isOwner(admin)
  if (!isFakeEngine()) syncDeployerSites()
  const settings = getSettings()
  const current = await latestVersion()
  const states = new Map(listClubs().map((c) => [c.id, c.status]))
  // Outside sites and other people's sites are for owners only.
  const sites = listWatched().filter((s) => owner || canSeeSite(admin, s.clubId))
  const checked = sites.filter((s) => isChecked(s, states))
  const down = checked.filter((s) => s.status === 'down')
  const behind = checked.filter((s) => isBehind(s.version, current))
  const counted = sites.filter((s) => s.members !== null)
  const totalMembers = counted.reduce((n, s) => n + (s.members ?? 0), 0)
  const totalStaff = counted.reduce((n, s) => n + (s.staff ?? 0), 0)
  const emailOn = mailReady()
  const order = (s: (typeof sites)[number]) => (!isChecked(s, states) ? 3 : s.status === 'down' ? 0 : s.fails > 0 ? 1 : 2)
  const rows = [...sites].sort((a, b) => order(a) - order(b))
  // Labels: one table per label (a site with several is in each), "No label" last.
  const labels = listLabels()
  const bySite = labelsBySite()
  const labelById = new Map(labels.map((l) => [l.id, l]))
  const labelInfo = labels.map((l) => ({ id: l.id, name: l.name, color: l.color, sites: l.sites }))
  const listView = search.view === 'list' || labels.length === 0
  const show = parseShow(search.show)
  const groups = listView ? [{ label: null as MonitorLabel | null, sites: filterSites(rows, bySite, show) }] : groupSites(rows, labels, bySite, show)
  const unlabelled = rows.filter((s) => !(bySite.get(s.id) ?? []).length).length
  const chipKeys = [...labels.map((l) => String(l.id)), ...(unlabelled ? ['none'] : [])]
  const href = (view: string | undefined, next: Set<string>) => {
    const q = new URLSearchParams()
    if (view === 'list') q.set('view', 'list')
    const keys = chipKeys.filter((k) => next.has(k))
    if (keys.length && keys.length < chipKeys.length) q.set('show', keys.join(','))
    const qs = q.toString()
    return qs ? `/admin/monitor?${qs}` : '/admin/monitor'
  }
  const isShown = (key: string) => show.size === 0 || show.has(key)
  const toggle = (key: string) => {
    const next = new Set(show.size === 0 ? chipKeys : [...show])
    if (next.has(key)) next.delete(key); else next.add(key)
    return href(listView ? 'list' : undefined, next)
  }
    const siteRow = (s: (typeof sites)[number], group: MonitorLabel | null) => {
    const on = isChecked(s, states)
    const week = uptime(s.id, 24 * 7)
    const own = (bySite.get(s.id) ?? []).map((id) => labelById.get(id)).filter((l): l is MonitorLabel => !!l)
    const others = listView ? own : own.filter((l) => l.id !== group?.id)
    return (
      <tr key={s.id}>
        <td>
          <Link href={`/admin/monitor/${s.id}`}><strong>{s.name}</strong></Link><div className="muted small">{s.url.replace(/^https:\/\//, '')} · {s.clubId !== null ? 'this deployer' : 'hosted elsewhere'}</div>
          {others.length > 0 && <div className="lbl-also">{!listView && <span className="muted small">also in</span>}{others.map((l) => <LabelChip key={l.id} name={l.name} color={l.color} />)}</div>}
        </td>
        <td><StatusBadge site={s} checked={on} />{on && s.status === 'down' && s.statusSince && <div className="muted small">since {ago(s.statusSince)}</div>}</td>
        <td>{on && s.lastMs !== null && s.status !== 'down' ? `${s.lastMs} ms` : <span className="muted">–</span>}</td>
        <td>{week.percent === null ? <span className="muted">–</span> : `${week.percent}%`}</td>
        <td>{s.members !== null ? <>{s.members.toLocaleString('en')}<div className="muted small">+ {s.staff ?? 0} staff</div></> : <span className="muted" title={s.statsError || (s.clubId === null && !s.hasStatsKey ? 'Add a key on the site\'s page to see its numbers' : '')}>–</span>}</td>
        <td>{s.version ? <>{s.version}{isBehind(s.version, current) && <span className="badge warn" style={{ marginLeft: 6 }}>Behind</span>}</> : <span className="muted" title={s.hasHealth ? '' : 'The site has no /api/health, so its home page is checked instead'}>{s.lastCheckedAt && !s.hasHealth ? 'Not reported' : '–'}</span>}</td>
        <td><CertCell site={s} /></td>
        <td className="muted small">{ago(s.lastCheckedAt) || '–'}</td>
        {owner && <td className="row-actions">
          <Popup label="Edit" icon="edit" title={`Edit ${s.name}`} subtitle={<>{s.url.replace(/^https:\/\//, '')} · {s.clubId !== null ? 'run by this deployer' : 'hosted elsewhere'}</>}>
            <ActionForm action={saveWatchedAction} submit="Save">
              <input type="hidden" name="id" value={s.id} />
              {s.clubId !== null ? <p className="muted small">The name and address follow the site under Sites, so they can&apos;t be changed here.</p> : (
                <div className="grid cols-2">
                  <div className="field"><label htmlFor={`name-${s.id}`}>Name</label><input id={`name-${s.id}`} name="name" type="text" maxLength={80} defaultValue={s.name} required /></div>
                  <div className="field"><label htmlFor={`url-${s.id}`}>Web address</label><input id={`url-${s.id}`} name="url" type="text" defaultValue={s.url} required /></div>
                </div>
              )}
              <LabelPicker all={labelInfo} initial={own.map((l) => l.name)} id={`labels-${s.id}`} />
              <label className="small" style={{ fontWeight: 400 }}><input type="checkbox" name="paused" defaultChecked={s.paused} /> Pause checks and alerts for this site</label>
              <p className="muted small" style={{ marginTop: 12 }}>{s.clubId === null ? 'The key for user numbers and Stop watching are on ' : 'Check history is on '}<Link href={`/admin/monitor/${s.id}`}>the site&apos;s page</Link>.</p>
            </ActionForm>
          </Popup>
        </td>}
      </tr>
    )
  }
  // Same column widths in every table, so the grouped tables line up.
  const colgroup = <colgroup><col /><col style={{ width: 110 }} /><col style={{ width: 80 }} /><col style={{ width: 90 }} /><col style={{ width: 85 }} /><col style={{ width: 140 }} /><col style={{ width: 120 }} /><col style={{ width: 95 }} />{owner && <col style={{ width: 96 }} />}</colgroup>
  const head = <thead><tr><th>Site</th><th>Status</th><th>Speed</th><th>Up, 7 days</th><th>Users</th><th>Version</th><th>Certificate</th><th>Checked</th>{owner && <th><span className="sr-only">Edit</span></th>}</tr></thead>
  return (
    <>
      <AutoRefresh seconds={30} />
      <div className="page-head">
        <div><h1>Monitoring</h1><p className="muted">Every site is checked every {settings.monitorMinutes} minute{settings.monitorMinutes === 1 ? '' : 's'}: the ones this deployer runs, and any site you add that is hosted somewhere else.</p></div>
        {owner && <Toolbar>
          <form action={checkNowAction}><SubmitButton busy="Checking…"><Icon name="refresh" size={16} /><span className="tb-label">Check all now</span></SubmitButton></form>
          <Popup label="Alerts" icon="bell" subtitle="An email goes out when a site is down (two failed checks in a row), when it is back, and when a certificate has 14 and then 3 days left.">
            {!emailOn && <div className="notice warn">No alert emails are sent yet: set up outgoing email under <Link href="/admin/settings">Settings</Link> first.</div>}
            <ActionForm action={saveAlertSettingsAction} submit="Save" extra={<button name="intent" value="test">Save and send a test email</button>}>
            <div className="field"><label htmlFor="alertEmails">Send alerts to</label><input id="alertEmails" name="alertEmails" type="text" defaultValue={settings.alertEmails} placeholder={alertRecipients().join(', ')} /><div className="help">One or more email addresses, separated by commas. Leave empty to email every owner.</div></div>
            <div className="field"><label htmlFor="monitorMinutes">Check every (minutes)</label><input id="monitorMinutes" name="monitorMinutes" type="number" min={1} max={60} defaultValue={settings.monitorMinutes} required style={{ maxWidth: 120 }} /></div>
          </ActionForm>
          </Popup>
          <Popup label="Labels" icon="tag" title="Labels" subtitle="Rename, recolour, reorder or delete labels. Each label is its own table on this page, in this order.">
            <ActionForm action={saveLabelsAction} submit="Save labels">
              <LabelsEditor labels={labelInfo} />
            </ActionForm>
          </Popup>
          <span className="tb-sep" />
          <Popup label="Watch a site" short="Watch" title="Watch a site hosted elsewhere" icon="plus" primary subtitle="For a site on its own VM, on Railway or anywhere else. The site needs nothing installed: the deployer only reads its public address.">
            <ActionForm action={addWatchedAction} submit="Add and check" busy="Checking…">
            <div className="field"><label htmlFor="w-url">Web address</label><input id="w-url" name="url" type="text" placeholder="https://www.example.com" required /></div>
            <div className="field"><label htmlFor="w-name">Name</label><input id="w-name" name="name" type="text" maxLength={80} placeholder="Example Club" /><div className="help">Leave empty to use the address.</div></div>
          </ActionForm>
          </Popup>
        </Toolbar>}
      </div>

      <div className="grid cols-3" style={{ marginBottom: 16 }}>
        <div className="card" style={{ marginBottom: 0 }}><div className="stat">{checked.length - down.length} of {checked.length}</div><div className="stat-label">sites up</div></div>
        <div className="card" style={{ marginBottom: 0 }}><div className="stat" style={down.length ? { color: 'var(--bad)' } : undefined}>{down.length}</div><div className="stat-label">down right now</div></div>
        <div className="card" style={{ marginBottom: 0 }}><div className="stat">{counted.length ? totalMembers.toLocaleString('en') : '–'}</div><div className="stat-label">{counted.length ? `members across ${counted.length} site${counted.length === 1 ? '' : 's'}, plus ${totalStaff.toLocaleString('en')} staff` : 'members (no site reports numbers yet)'}</div></div>
        <div className="card" style={{ marginBottom: 0 }}><div className="stat">{behind.length}</div><div className="stat-label">behind{current ? ` the newest version, ${current}` : ' the newest version'}</div></div>
      </div>

      {labels.length > 0 && rows.length > 0 && (
        <div className="mon-filters">
          <div className="seg" role="group" aria-label="View">
            <Link href={href(undefined, show)} className={!listView ? 'on' : undefined} aria-current={!listView ? 'true' : undefined}>Group by labels</Link>
            <Link href={href('list', show)} className={listView ? 'on' : undefined} aria-current={listView ? 'true' : undefined}>One list</Link>
          </div>
          <div className="mon-chips">
            <span className="muted small">Show</span>
            {labels.map((l) => <Link key={l.id} href={toggle(String(l.id))} className={`lbl lbl-${l.color}${isShown(String(l.id)) ? '' : ' off'}`} aria-pressed={isShown(String(l.id))}>{l.name} · {l.sites}</Link>)}
            {unlabelled > 0 && <Link href={toggle('none')} className={`lbl lbl-grey${isShown('none') ? '' : ' off'}`} aria-pressed={isShown('none')}>No label · {unlabelled}</Link>}
            {show.size > 0 && <Link href={href(listView ? 'list' : undefined, new Set())} className="small">Show all</Link>}
          </div>
        </div>
      )}

      {rows.length === 0 ? <div className="card"><p className="muted" style={{ margin: 0 }}>{owner ? 'Nothing is being watched yet. Add a site below, or create one under Sites.' : 'None of your sites are being watched yet.'}</p></div>
        : groups.every((g) => g.sites.length === 0) ? <div className="card"><p className="muted" style={{ margin: 0 }}>No sites match. <Link href={href(listView ? 'list' : undefined, new Set())}>Show all</Link></p></div>
        : groups.map((g) => {
          const on = g.sites.filter((s) => isChecked(s, states))
          const gDown = on.filter((s) => s.status === 'down').length
          const gBehind = on.filter((s) => isBehind(s.version, current)).length
          const table = <div className="table-wrap"><table className="mon-table">{colgroup}{head}<tbody>{g.sites.map((s) => siteRow(s, g.label))}</tbody></table></div>
          if (listView) return <div className="card" key="list">{table}</div>
          return (
            <section className="card" key={g.label?.id ?? 'none'} aria-label={g.label?.name ?? 'No label'}>
              <h2 className="group-head">
                {g.label ? <LabelChip name={g.label.name} color={g.label.color} /> : <LabelChip name="No label" color="grey" />}
                <span className="muted small group-count">{g.sites.length} site{g.sites.length === 1 ? '' : 's'}</span>
                <span className="group-sum small">
                  <span><strong className={gDown ? undefined : 'ok-text'}>{on.length - gDown} of {on.length}</strong> up</span>
                  <span className={gDown ? 'bad-text' : 'muted'}>{gDown} down</span>
                  <span className="muted">{gBehind} behind</span>
                </span>
              </h2>
              {table}
            </section>
          )
        })}

    </>
  )
}
