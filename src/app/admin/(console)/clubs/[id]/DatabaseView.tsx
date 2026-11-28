import Link from 'next/link'
import { getServer, type Club } from '@/lib/clubs'
import { maskedLog } from '@/lib/logs'
import { OP_LABELS, listOperations } from '@/lib/ops'
import { PG_MEMORY_MAX, PG_MEMORY_MIN, PG_VERSIONS, pgVarsShown, pgVersionOf } from '@/lib/projects'
import { appsUsing, projectOf } from '@/lib/services'
import { backupsReady } from '@/lib/backups/run'
import { ActionForm } from '@/components/ActionForm'
import { AutoRefresh } from '@/components/AutoRefresh'
import { BackupsCard } from '@/components/BackupsCard'
import { ClubLogs } from '@/components/ClubLogs'
import { DumpUpload } from '@/components/DumpUpload'
import { LiveClubMemory } from '@/components/LiveServer'
import { MoveProject } from '@/components/MoveProject'
import { OperationLog } from '@/components/OperationLog'
import { SubmitButton } from '@/components/SubmitButton'
import { Icon } from '@/components/Icon'
import { MoreMenu, Popup, Toolbar } from '@/components/Popup'
import { ClubBadge, OpBadge, fmtTime } from '@/components/ui'
import { clubOperationAction, removeClubAction } from '../../actions'
import { retryDatabaseAction, revealDatabaseAction, rotateDatabaseAction, updateDatabaseAction, upgradeDatabaseAction } from '../../projects/actions'

const fmtSize = (bytes: number | null) => (bytes === null ? 'not measured yet' : bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toLocaleString('en', { maximumFractionDigits: 0 })} MB`)

/** The page of a PostgreSQL database service. */
export function DatabaseView({ club, can }: { club: Club; can: { operate: boolean; owner: boolean } }) {
  const server = getServer(club.serverId)
  const project = projectOf(club)
  const ops = listOperations({ clubId: club.id, limit: 15 })
  const latest = ops[0]
  const busy = !!latest && (latest.status === 'queued' || latest.status === 'running')
  const usable = club.status === 'running' || club.status === 'paused'
  const users = appsUsing(club.id)
  const version = pgVersionOf(club.image)
  const newer = PG_VERSIONS.filter((v) => Number(v) > Number(version))
  const pct = club.pgSizeBytes !== null ? Math.round((club.pgSizeBytes / (club.pgQuotaMb * 1024 * 1024)) * 100) : null
  const quotaGb = club.pgQuotaMb / 1024

  return (
    <>
      {busy && <AutoRefresh seconds={5} />}
      <div className="page-head">
        <div>
          <p className="small" style={{ marginBottom: 4 }}>{project ? <Link href={`/admin/projects/${project.id}`}>← {project.displayName}</Link> : <Link href="/admin/services">← Sites</Link>}</p>
          <h1>{club.displayName} <ClubBadge status={club.status} /> <span className="badge info">PostgreSQL {version}</span></h1>
          <p className="muted">Inside the project at <span className="mono">{club.name}:5432</span>. Not reachable from the internet.</p>
        </div>
        <Toolbar>
          {can.operate && usable && (
            <Popup label="Connect" icon="link" title="Connect to this database" sticky panel subtitle="Apps in this project get these values when you tick this database in their settings.">
              <table><tbody>{pgVarsShown(club.name).map((v) => <tr key={v.key}><td className="mono small">{v.key}</td><td className="mono small wrap">{v.value}</td></tr>)}</tbody></table>
              <p className="help">Or use one value in any app setting: <span className="mono">{'${{'}{club.name}.DATABASE_URL{'}}'}</span>. The password is filled in on the server.</p>
              <h3 style={{ marginTop: 16 }}>Show the password</h3>
              <p className="muted small">Shows the real values once (they stay in the message until you close it). Each time is written to the access log.</p>
              <ActionForm action={revealDatabaseAction} submit="Show values" busy="Asking the server…"><input type="hidden" name="id" value={club.id} /></ActionForm>
            </Popup>
          )}
          {can.operate && usable && !busy && (
            <>
              {club.status === 'running' && <form action={clubOperationAction}><input type="hidden" name="id" value={club.id} /><input type="hidden" name="kind" value="backup" /><SubmitButton busy="Queuing…"><Icon name="db" size={16} /><span className="tb-label">Back up</span></SubmitButton></form>}
              {club.status === 'running' ? (
                <form action={clubOperationAction}><input type="hidden" name="id" value={club.id} /><input type="hidden" name="kind" value="pause" /><SubmitButton busy="Queuing…"><Icon name="pause" size={16} /><span className="tb-label">Pause</span></SubmitButton></form>
              ) : (
                <form action={clubOperationAction}><input type="hidden" name="id" value={club.id} /><input type="hidden" name="kind" value="resume" /><SubmitButton busy="Queuing…"><Icon name="play" size={16} /><span className="tb-label">Resume</span></SubmitButton></form>
              )}
              <span className="tb-sep" />
              <Popup label="Settings" icon="sliders" panel>
                <ActionForm action={updateDatabaseAction} submit="Save" busy="Saving…">
                  <input type="hidden" name="id" value={club.id} />
                  <div className="field"><label htmlFor="displayName">Name</label><input id="displayName" name="displayName" type="text" defaultValue={club.displayName} maxLength={80} /></div>
                  <div className="grid cols-2">
                    <div className="field"><label htmlFor="memoryMb">Memory (MB)</label><input id="memoryMb" name="memoryMb" type="number" min={PG_MEMORY_MIN} max={PG_MEMORY_MAX} defaultValue={club.memoryMb} /><div className="help">Changing it restarts the database (a few seconds).</div></div>
                    <div className="field"><label htmlFor="quotaGb">Disk quota (GB)</label><input id="quotaGb" name="quotaGb" type="number" min={0.25} max={195} step={0.25} defaultValue={quotaGb} /><div className="help">Emails at 80%; read-only at 100%.</div></div>
                  </div>
                  <div className="field"><label htmlFor="notes">Notes (only shown here)</label><textarea id="notes" name="notes" defaultValue={club.notes} style={{ fontFamily: 'inherit', fontSize: 'inherit' }} /></div>
                </ActionForm>
              </Popup>
            </>
          )}
          {can.operate && !busy && club.status !== 'removing' && (
            <MoreMenu>
              {club.status === 'running' && <a className="menu-item" href={`/api/admin/clubs/${club.id}/dump`} download><Icon name="backups" size={16} /> Download a dump</a>}
              {club.status === 'running' && (
                <Popup menu label="Load a dump…" title="Replace the data with a dump" icon="up" danger>
                  <p className="muted small">Loads the file beside the live data, then swaps it in. {backupsReady() ? 'A backup to the bucket is taken first.' : 'Set up backups first if you may want the current data back.'} Apps using it restart.</p>
                  <DumpUpload id={club.id} name={club.name} />
                </Popup>
              )}
              {club.status === 'running' && (
                <Popup menu label="New password…" title="Give the database a new password" icon="key">
                  <p className="muted">Changes the password on the server{users.length ? `, then restarts ${users.map((a) => a.displayName).join(', ')} with it` : ''}. Anything else that used the old one stops working.</p>
                  <ActionForm action={rotateDatabaseAction} submit="Make a new password" busy="Queuing…"><input type="hidden" name="id" value={club.id} /></ActionForm>
                </Popup>
              )}
              {club.status === 'running' && newer.length > 0 && (
                <Popup menu label="Newer PostgreSQL…" title="Move to a newer PostgreSQL" icon="up">
                  <p className="muted small">Copies the data out, starts the new version and loads it back in; apps can&apos;t reach it for a minute or so. {backupsReady() ? 'A backup goes to the bucket first. ' : ''}If anything fails it goes back to PostgreSQL {version} with its data as it was.</p>
                  <ActionForm action={upgradeDatabaseAction} submit="Move" busy="Queuing…">
                    <input type="hidden" name="id" value={club.id} />
                    <div className="field"><label htmlFor="pg-version">Version</label><select id="pg-version" name="version">{newer.map((v) => <option key={v} value={v}>PostgreSQL {v}</option>)}</select></div>
                  </ActionForm>
                </Popup>
              )}
              {can.owner && usable && <MoveProject club={club} />}
              {can.owner && <hr />}
              {can.owner && <Popup menu danger label="Remove this database…" title="Remove this database" icon="trash">
                {users.length ? <p className="muted">{users.map((a) => a.displayName).join(', ')} still {users.length === 1 ? 'uses' : 'use'} it. Disconnect {users.length === 1 ? 'it' : 'them'} in the app&apos;s settings first.</p> : (
                  <>
                    <p className="muted">Takes a final copy (kept on the server{backupsReady() ? ' and in the bucket' : ''}), then deletes the database and its data. This can&apos;t be undone from here.</p>
                    <ActionForm action={removeClubAction} submit="Remove database" busy="Removing…" danger>
                      <input type="hidden" name="id" value={club.id} />
                      <div className="field"><label htmlFor="confirm">Type <span className="mono">{club.name}</span> to confirm</label><input id="confirm" name="confirm" type="text" autoComplete="off" style={{ maxWidth: 260 }} /></div>
                      {club.status === 'failed' && <label className="small" style={{ fontWeight: 400 }}><input type="checkbox" name="recordOnly" defaultChecked /> It was never created: just delete this record</label>}
                    </ActionForm>
                  </>
                )}
              </Popup>}
            </MoreMenu>
          )}
        </Toolbar>
      </div>

      {club.pgReadOnly && <div className="notice bad">This database is full ({fmtSize(club.pgSizeBytes)} of its {quotaGb.toLocaleString('en')} GB quota), so it only reads: apps can&apos;t save anything new. Raise the quota in Settings or delete data; writes start again within 5 minutes.</div>}
      {!club.pgReadOnly && pct !== null && pct >= 80 && <div className="notice warn">This database is {pct}% full. At 100% it stops taking writes.</div>}
      {club.projectSynced === 2 && <div className="notice warn">This server&apos;s clubctl is too old for projects. Run the &quot;Set up a VM&quot; workflow for {server?.name ?? 'it'} again, then press Connect services on the Projects page.</div>}

      {latest && (busy || latest.status === 'failed') && (
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
            <h2 style={{ margin: 0 }}>{OP_LABELS[latest.kind]}</h2>
            <OpBadge status={latest.status} />
          </div>
          <OperationLog key={latest.id} id={latest.id} initialStatus={latest.status} initialLog={maskedLog(latest.log, club)} />
        </div>
      )}

      {can.operate && club.status === 'failed' && !busy && (
        <div className="card">
          <h2>This database wasn&apos;t created</h2>
          <p className="muted">Read the output above. Often the server ran short of memory or disk, or its clubctl is older than PostgreSQL services (run &quot;Set up a VM&quot; again).</p>
          <form action={retryDatabaseAction}><input type="hidden" name="id" value={club.id} /><SubmitButton className="primary">Try again</SubmitButton></form>
        </div>
      )}

      <div className="grid cols-2">
        <div className="card" style={{ marginBottom: 0 }}>
          <h2>About</h2>
          <dl className="facts">
            <dt>Name</dt><dd className="mono">{club.name}</dd>
            <dt>Project</dt><dd>{project ? <Link href={`/admin/projects/${project.id}`}>{project.displayName}</Link> : '–'}</dd>
            <dt>Version</dt><dd className="mono">{club.image}</dd>
            <dt>Size</dt><dd>
              {club.pgSizeBytes === null ? `Not measured yet (quota ${quotaGb.toLocaleString('en')} GB)` : `${fmtSize(club.pgSizeBytes)} of ${quotaGb.toLocaleString('en')} GB${pct !== null ? ` (${pct}%)` : ''}`}
              {pct !== null && <div className={`bar${pct >= 100 ? ' high' : pct >= 80 ? ' warn' : ''}`} style={{ marginTop: 4, maxWidth: 260 }}><span style={{ width: `${Math.min(100, Math.max(2, pct))}%` }} /></div>}
            </dd>
            <dt>Connections</dt><dd>{club.pgConnections ?? '–'}{club.pgMaxConnections ? ` of ${club.pgMaxConnections}` : ''}{club.pgCheckedAt ? <span className="muted small"> · checked {fmtTime(club.pgCheckedAt)}</span> : null}</dd>
            <dt>Used by</dt><dd>{users.length ? users.map((a, i) => <span key={a.id}>{i ? ', ' : ''}<Link href={`/admin/clubs/${a.id}`}>{a.displayName}</Link></span>) : <span className="muted">No app yet. Tick it under Databases in an app&apos;s settings.</span>}</dd>
            <dt>Server</dt><dd>{server?.name ?? 'missing'}</dd>
            <dt>Memory</dt><dd>{server && usable ? <LiveClubMemory serverId={server.id} name={club.name} /> : '–'} <span className="muted">(limit {club.memoryMb} MB)</span></dd>
            {club.notes && <><dt>Notes</dt><dd className="small">{club.notes}</dd></>}
            <dt>Created</dt><dd>{fmtTime(club.createdAt)}</dd>
          </dl>
        </div>
        <div className="card" style={{ marginBottom: 0 }}>
          <h2>From outside the project</h2>
          <p className="muted small" style={{ marginTop: 0 }}>The database has no port on the internet. To work on its data from your computer:</p>
          <ul className="small">
            <li><strong>Download a dump</strong> (More menu) and load it locally with <span className="mono">pg_restore -d mydb file.dump</span>.</li>
            <li><strong>Load a dump</strong> (More menu) made with <span className="mono">pg_dump -Fc</span> to replace the data here.</li>
            <li>Or run a one-off command from an app in the project, such as its pre-deploy step (migrations).</li>
          </ul>
        </div>
      </div>

      {can.operate && club.status !== 'creating' && <div style={{ marginTop: 16 }}><BackupsCard club={club} configured={backupsReady()} busy={busy} owner={can.owner} /></div>}

      {usable && (
        <div className="card">
          <h2>Logs</h2>
          <ClubLogs clubId={club.id} name={club.name} />
        </div>
      )}

      <div className="card">
        <h2>History</h2>
        {ops.length === 0 ? <p className="muted" style={{ margin: 0 }}>Nothing yet.</p> : (
          <div className="table-wrap"><table>
            <thead><tr><th>What</th><th>Result</th><th>When</th><th>By</th><th></th></tr></thead>
            <tbody>{ops.map((o) => (
              <tr key={o.id}>
                <td>{OP_LABELS[o.kind]}</td><td><OpBadge status={o.status} /></td><td className="muted">{fmtTime(o.createdAt)}</td><td className="muted">{o.createdBy}</td>
                <td><Link href={`/admin/activity?op=${o.id}`}>Output</Link></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
    </>
  )
}
