import Link from 'next/link'
import { requireAdmin } from '@/lib/auth'
import { canSeeSite, isOwner } from '@/lib/access'
import { AUDIT_LABELS, auditView, listAudit } from '@/lib/audit'
import { getClub } from '@/lib/clubs'
import { maskedLog } from '@/lib/logs'
import { OP_LABELS, getOperation, listOperations } from '@/lib/ops'
import { OperationLog } from '@/components/OperationLog'
import { OpBadge, fmtTime } from '@/components/ui'

export const metadata = { title: 'Activity' }

export default async function ActivityPage({ searchParams }: { searchParams: Promise<{ op?: string; tab?: string }> }) {
  const admin = await requireAdmin()
  const owner = isOwner(admin)
  const { op: opId, tab } = await searchParams
  const mine = (clubId: number | null) => owner || canSeeSite(admin, clubId)
  const found = opId ? getOperation(Number(opId)) : null
  const selected = found && mine(found.clubId) ? found : null
  const selectedClub = selected?.clubId ? getClub(selected.clubId) : null
  if (selected && selectedClub) await auditView(admin, 'viewed-output', selectedClub, `Operation ${selected.id}`)
  const accessTab = owner && tab === 'access'
  // Non-owners see the newest 100 operations of their own sites.
  const ops = accessTab ? [] : listOperations({ limit: owner ? 100 : 200 }).filter((o) => mine(o.clubId)).slice(0, 100)
  const entries = accessTab ? listAudit({ limit: 300 }) : []
  return (
    <>
      <div className="page-head"><div><h1>Activity</h1><p className="muted">{accessTab ? 'Who signed in, changed access or settings, and read which logs, newest first. Kept for a year.' : owner ? 'Every change made to a site, newest first.' : 'Every change made to your sites, newest first.'}</p></div></div>
      {owner && (
        <div className="tabs-row" role="tablist">
          <Link href="/admin/activity" className={accessTab ? '' : 'on'} aria-selected={!accessTab} role="tab">Changes to sites</Link>
          <Link href="/admin/activity?tab=access" className={accessTab ? 'on' : ''} aria-selected={accessTab} role="tab">Access log</Link>
        </div>
      )}
      {selected && !accessTab && (
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
            <h2 style={{ margin: 0 }}>{OP_LABELS[selected.kind]}: {selected.clubName}</h2>
            <OpBadge status={selected.status} />
          </div>
          <OperationLog key={selected.id} id={selected.id} initialStatus={selected.status} initialLog={maskedLog(selected.log, selectedClub)} />
        </div>
      )}
      {accessTab ? (
        <div className="card">
          {entries.length === 0 ? <p className="muted" style={{ margin: 0 }}>Nothing yet.</p> : (
            <div className="table-wrap"><table>
              <thead><tr><th>When</th><th>Who</th><th>What</th><th>Site</th><th>Details</th><th>IP</th></tr></thead>
              <tbody>{entries.map((e) => (
                <tr key={e.id}>
                  <td className="muted">{fmtTime(e.at)}</td>
                  <td>{e.actorEmail || <span className="muted">unknown</span>}</td>
                  <td>{e.action === 'sign-in-failed' || e.action === 'code-failed' ? <span className="badge warn">{AUDIT_LABELS[e.action]}</span> : AUDIT_LABELS[e.action] ?? e.action}</td>
                  <td>{e.clubId && getClub(e.clubId) ? <Link href={`/admin/clubs/${e.clubId}`}>{e.clubName}</Link> : <span className="muted">{e.clubName || '–'}</span>}</td>
                  <td className="muted small wrap">{e.detail}</td>
                  <td className="muted small mono">{e.ip}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </div>
      ) : (
        <div className="card">
          {ops.length === 0 ? <p className="muted" style={{ margin: 0 }}>Nothing yet.</p> : (
            <div className="table-wrap"><table>
              <thead><tr><th>Site</th><th>What</th><th>Result</th><th>Started</th><th>Finished</th><th>By</th><th></th></tr></thead>
              <tbody>{ops.map((o) => (
                <tr key={o.id}>
                  <td>{o.clubId ? <Link href={`/admin/clubs/${o.clubId}`}>{o.clubName}</Link> : <span className="muted">{o.clubName} (removed)</span>}</td>
                  <td>{OP_LABELS[o.kind]}</td><td><OpBadge status={o.status} /></td>
                  <td className="muted">{fmtTime(o.startedAt ?? o.createdAt)}</td><td className="muted">{fmtTime(o.finishedAt)}</td><td className="muted">{o.createdBy}</td>
                  <td><Link href={`/admin/activity?op=${o.id}`}>Output</Link></td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </div>
      )}
    </>
  )
}
