import Link from 'next/link'
import { getServer, type Club } from '@/lib/clubs'
import { clubDomains } from '@/lib/clubEnv'
import { maskedLog } from '@/lib/logs'
import { OP_LABELS, listOperations } from '@/lib/ops'
import { linksToDb, S3_MAX_BUCKETS, S3_MEMORY_MAX, S3_MEMORY_MIN, s3VarsShown } from '@/lib/projects'
import { appsUsing, projectOf } from '@/lib/services'
import { getSettings } from '@/lib/settings'
import { backupsReady } from '@/lib/backups/run'
import { ActionForm } from '@/components/ActionForm'
import { AutoRefresh } from '@/components/AutoRefresh'
import { BackupsCard } from '@/components/BackupsCard'
import { ClubLogs } from '@/components/ClubLogs'
import { LiveClubMemory } from '@/components/LiveServer'
import { MoveProject } from '@/components/MoveProject'
import { OperationLog } from '@/components/OperationLog'
import { SubmitButton } from '@/components/SubmitButton'
import { Icon } from '@/components/Icon'
import { MoreMenu, Popup, Toolbar } from '@/components/Popup'
import { ClubBadge, OpBadge, fmtTime } from '@/components/ui'
import { clubOperationAction, removeClubAction } from '../../actions'
import {
  addBucketAction, bucketAccessAction, removeBucketAction, retryStorageAction, revealStorageAction, rotateStorageAction, updateStorageAction,
} from '../../projects/actions'

const fmtSize = (bytes: number | null) => (bytes === null ? '–' : bytes < 1024 * 1024 ? `${Math.max(bytes ? 1 : 0, Math.round(bytes / 1024))} KB` : bytes < 1024 ** 3 ? `${Math.round(bytes / 1024 / 1024).toLocaleString('en')} MB` : `${(bytes / 1024 ** 3).toLocaleString('en', { maximumFractionDigits: 1 })} GB`)

/** The page of an S3 storage service (MinIO). */
export function StorageView({ club, can }: { club: Club; can: { operate: boolean; owner: boolean } }) {
  const server = getServer(club.serverId)
  const project = projectOf(club)
  const ops = listOperations({ clubId: club.id, limit: 15 })
  const latest = ops[0]
  const busy = !!latest && (latest.status === 'queued' || latest.status === 'running')
  const usable = club.status === 'running' || club.status === 'paused'
  const running = club.status === 'running'
  const users = appsUsing(club.id)
  const links = linksToDb(club.id)
  const domain = club.appPublic ? clubDomains(club, getSettings().baseDomain)[0] : null
  const publicUrl = domain ? `https://${domain}` : null
  const pct = club.pgSizeBytes !== null ? Math.round((club.pgSizeBytes / (club.pgQuotaMb * 1024 * 1024)) * 100) : null
  const quotaGb = club.pgQuotaMb / 1024
  const usersOf = (bucket: string) => links.filter((l) => l.bucket === bucket || (!l.bucket && club.s3Buckets[0]?.name === bucket))
    .map((l) => users.find((a) => a.id === l.appId)).filter((a): a is Club => !!a)

  return (
    <>
      {busy && <AutoRefresh seconds={5} />}
      <div className="page-head">
        <div>
          <p className="small" style={{ marginBottom: 4 }}>{project ? <Link href={`/admin/projects/${project.id}`}>← {project.displayName}</Link> : <Link href="/admin/services">← Sites</Link>}</p>
          <h1>{club.displayName} <ClubBadge status={club.status} /> <span className="badge info">S3 storage</span></h1>
          <p className="muted">Inside the project at <span className="mono">http://{club.name}:9000</span>.{' '}
            {domain ? <>On the web at <a href={publicUrl!} target="_blank" rel="noreferrer">{domain}</a> (files in public buckets, and signed links).</> : 'Not reachable from the internet.'}</p>
        </div>
        <Toolbar>
          {can.operate && usable && (
            <Popup label="Connect" icon="link" title="Connect to this storage" sticky panel subtitle="Apps in this project get these values when you tick this storage in their settings.">
              <table><tbody>{s3VarsShown(club.name, { bucket: club.s3Buckets[0]?.name, publicUrl }).map((v) => <tr key={v.key}><td className="mono small">{v.key}</td><td className="mono small wrap">{v.value}</td></tr>)}</tbody></table>
              <p className="help">Or use one value in any app setting: <span className="mono">{'${{'}{club.name}.S3_ENDPOINT{'}}'}</span>. The secret key is filled in on the server. Any S3 SDK works with path-style addressing.</p>
              <h3 style={{ marginTop: 16 }}>Show the secret key</h3>
              <p className="muted small">Shows the real values once (they stay in the message until you close it). Each time is written to the access log.</p>
              <ActionForm action={revealStorageAction} submit="Show values" busy="Asking the server…"><input type="hidden" name="id" value={club.id} /></ActionForm>
            </Popup>
          )}
          {can.operate && usable && !busy && (
            <>
              {running && <form action={clubOperationAction}><input type="hidden" name="id" value={club.id} /><input type="hidden" name="kind" value="backup" /><SubmitButton busy="Queuing…"><Icon name="db" size={16} /><span className="tb-label">Back up</span></SubmitButton></form>}
              {running ? (
                <form action={clubOperationAction}><input type="hidden" name="id" value={club.id} /><input type="hidden" name="kind" value="pause" /><SubmitButton busy="Queuing…"><Icon name="pause" size={16} /><span className="tb-label">Pause</span></SubmitButton></form>
              ) : (
                <form action={clubOperationAction}><input type="hidden" name="id" value={club.id} /><input type="hidden" name="kind" value="resume" /><SubmitButton busy="Queuing…"><Icon name="play" size={16} /><span className="tb-label">Resume</span></SubmitButton></form>
              )}
              <span className="tb-sep" />
              <Popup label="Settings" icon="sliders" panel>
                <ActionForm action={updateStorageAction} submit="Save" busy="Saving…">
                  <input type="hidden" name="id" value={club.id} />
                  <div className="field"><label htmlFor="displayName">Name</label><input id="displayName" name="displayName" type="text" defaultValue={club.displayName} maxLength={80} /></div>
                  <div className="grid cols-2">
                    <div className="field"><label htmlFor="memoryMb">Memory (MB)</label><input id="memoryMb" name="memoryMb" type="number" min={S3_MEMORY_MIN} max={S3_MEMORY_MAX} defaultValue={club.memoryMb} /><div className="help">Changing it restarts the storage (a few seconds).</div></div>
                    <div className="field"><label htmlFor="quotaGb">Quota (GB)</label><input id="quotaGb" name="quotaGb" type="number" min={1} max={2000} step={1} defaultValue={quotaGb} /><div className="help">Emails at 80% and 100%. Writes never stop; the server&apos;s disk is the real limit.</div></div>
                  </div>
                  <label className="small" style={{ fontWeight: 400, marginBottom: 14 }}><input type="checkbox" name="web" defaultChecked={club.appPublic} /> Give it a web address (<span className="mono">{club.name}.{getSettings().baseDomain}</span>) with HTTPS, so browsers can load files from public buckets and signed links</label>
                  <div className="field"><label htmlFor="notes">Notes (only shown here)</label><textarea id="notes" name="notes" defaultValue={club.notes} style={{ fontFamily: 'inherit', fontSize: 'inherit' }} /></div>
                </ActionForm>
              </Popup>
            </>
          )}
          {can.operate && !busy && club.status !== 'removing' && (
            <MoreMenu>
              {running && (
                <Popup menu label="New keys…" title="Give the storage a new secret key" icon="key">
                  <p className="muted">Makes a new secret key for apps{users.length ? `, then restarts ${users.map((a) => a.displayName).join(', ')} with it` : ''}. Anything else that used the old one stops working.</p>
                  <ActionForm action={rotateStorageAction} submit="Make a new key" busy="Queuing…"><input type="hidden" name="id" value={club.id} /></ActionForm>
                </Popup>
              )}
              {can.owner && usable && !users.length && <MoveProject club={club} />}
              {can.owner && <hr />}
              {can.owner && <Popup menu danger label="Remove this storage…" title="Remove this storage" icon="trash">
                {users.length ? <p className="muted">{users.map((a) => a.displayName).join(', ')} still {users.length === 1 ? 'uses' : 'use'} it. Untick it in the app&apos;s settings first.</p> : (
                  <>
                    <p className="muted">{backupsReady() ? 'Takes a final backup to the bucket, then stops' : 'Stops'} the storage and moves its files aside on the server (kept until you delete them there). This can&apos;t be undone from here.</p>
                    <ActionForm action={removeClubAction} submit="Remove storage" busy="Removing…" danger>
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

      {pct !== null && pct >= 100 && <div className="notice bad">This storage holds {fmtSize(club.pgSizeBytes)}, over its {quotaGb.toLocaleString('en')} GB quota. Apps can still save files; raise the quota in Settings or delete files.</div>}
      {pct !== null && pct >= 80 && pct < 100 && <div className="notice warn">This storage is {pct}% of its quota.</div>}
      {club.projectSynced === 2 && <div className="notice warn">This server&apos;s clubctl is too old for storage. Run the &quot;Set up a VM&quot; workflow for {server?.name ?? 'it'} again, then press Connect services on the Projects page.</div>}

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
          <h2>This storage wasn&apos;t created</h2>
          <p className="muted">Read the output above. Often the server ran short of memory or disk, or its clubctl is older than storage services (run &quot;Set up a VM&quot; again).</p>
          <form action={retryStorageAction}><input type="hidden" name="id" value={club.id} /><SubmitButton className="primary">Try again</SubmitButton></form>
        </div>
      )}

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
          <h2 style={{ margin: 0 }}>Buckets</h2>
          {can.operate && running && !busy && club.s3Buckets.length < S3_MAX_BUCKETS && (
            <Popup label="Add a bucket" icon="plus" title="Add a bucket">
              <ActionForm action={addBucketAction} submit="Add bucket" busy="Queuing…">
                <input type="hidden" name="id" value={club.id} />
                <div className="field"><label htmlFor="bucket">Name</label><input id="bucket" name="bucket" type="text" placeholder="uploads" maxLength={63} spellCheck={false} autoComplete="off" /><div className="help">3 to 63 lowercase letters, digits and hyphens.</div></div>
                <label className="small" style={{ fontWeight: 400 }}><input type="checkbox" name="public" /> Anyone with the link can read its files (for images on a website)</label>
              </ActionForm>
            </Popup>
          )}
        </div>
        <div className="table-wrap"><table>
          <thead><tr><th>Bucket</th><th>Who can read</th><th>Files</th><th>Size</th><th>Used by</th><th></th></tr></thead>
          <tbody>{club.s3Buckets.map((b) => {
            const by = usersOf(b.name)
            return (
              <tr key={b.name}>
                <td className="mono">{b.name}</td>
                <td>{b.public ? <span className="badge warn">Anyone with the link</span> : 'Apps only'}</td>
                <td>{b.objects ?? '–'}</td>
                <td>{fmtSize(b.bytes)}</td>
                <td>{by.length ? by.map((a, i) => <span key={a.id}>{i ? ', ' : ''}<Link href={`/admin/clubs/${a.id}`}>{a.displayName}</Link></span>) : <span className="muted">–</span>}</td>
                <td><div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>{can.operate && running && !busy && (
                  <Popup label="Access" icon="key" title={`Who can read ${b.name}`}>
                    <ActionForm action={bucketAccessAction} submit="Save" busy="Queuing…">
                      <input type="hidden" name="id" value={club.id} /><input type="hidden" name="bucket" value={b.name} />
                      <label className="small" style={{ fontWeight: 400, display: 'block' }}><input type="radio" name="access" value="private" defaultChecked={!b.public} /> Apps only (they use the key, or hand out signed links)</label>
                      <label className="small" style={{ fontWeight: 400, display: 'block', marginTop: 6 }}><input type="radio" name="access" value="public" defaultChecked={b.public} /> Anyone with the link can read its files</label>
                    </ActionForm>
                  </Popup>
                )}{can.operate && running && !busy && club.s3Buckets.length > 1 && (
                  <Popup label="Remove" icon="trash" title={`Remove the bucket ${b.name}`} danger>
                    {by.length ? <p className="muted">{by.map((a) => a.displayName).join(', ')} {by.length === 1 ? 'uses' : 'use'} it. Once it is gone they use the storage&apos;s first bucket.</p> : null}
                    <p className="muted small">Only an empty bucket is removed: delete its files first (from an app, or with an S3 tool).</p>
                    <ActionForm action={removeBucketAction} submit="Remove bucket" busy="Queuing…" danger>
                      <input type="hidden" name="id" value={club.id} /><input type="hidden" name="bucket" value={b.name} />
                      <div className="field"><label htmlFor={`confirm-${b.name}`}>Type <span className="mono">{b.name}</span> to confirm</label><input id={`confirm-${b.name}`} name="confirm" type="text" autoComplete="off" style={{ maxWidth: 220 }} /></div>
                    </ActionForm>
                  </Popup>
                )}</div></td>
              </tr>
            )
          })}</tbody>
        </table></div>
        <p className="help">File counts and sizes are checked every 5 minutes{club.pgCheckedAt ? ` (last ${fmtTime(club.pgCheckedAt)})` : ''}. {domain ? <>A public bucket&apos;s files are at <span className="mono">{publicUrl}/&lt;bucket&gt;/&lt;file&gt;</span>.</> : 'Public buckets need a web address (Settings) for browsers to reach them.'}</p>
      </div>

      <div className="grid cols-2">
        <div className="card" style={{ marginBottom: 0 }}>
          <h2>About</h2>
          <dl className="facts">
            <dt>Name</dt><dd className="mono">{club.name}</dd>
            <dt>Project</dt><dd>{project ? <Link href={`/admin/projects/${project.id}`}>{project.displayName}</Link> : '–'}</dd>
            <dt>Image</dt><dd className="mono small wrap">{club.image}</dd>
            <dt>Size</dt><dd>
              {club.pgSizeBytes === null ? `Not measured yet (quota ${quotaGb.toLocaleString('en')} GB)` : `${fmtSize(club.pgSizeBytes)} of ${quotaGb.toLocaleString('en')} GB${pct !== null ? ` (${pct}%)` : ''}`}
              {pct !== null && <div className={`bar${pct >= 100 ? ' high' : pct >= 80 ? ' warn' : ''}`} style={{ marginTop: 4, maxWidth: 260 }}><span style={{ width: `${Math.min(100, Math.max(2, pct))}%` }} /></div>}
            </dd>
            <dt>Used by</dt><dd>{users.length ? users.map((a, i) => <span key={a.id}>{i ? ', ' : ''}<Link href={`/admin/clubs/${a.id}`}>{a.displayName}</Link></span>) : <span className="muted">No app yet. Tick it under Databases and storage in an app&apos;s settings.</span>}</dd>
            <dt>Server</dt><dd>{server?.name ?? 'missing'}</dd>
            <dt>Memory</dt><dd>{server && usable ? <LiveClubMemory serverId={server.id} name={club.name} /> : '–'} <span className="muted">(limit {club.memoryMb} MB)</span></dd>
            {club.notes && <><dt>Notes</dt><dd className="small">{club.notes}</dd></>}
            <dt>Created</dt><dd>{fmtTime(club.createdAt)}</dd>
          </dl>
        </div>
        <div className="card" style={{ marginBottom: 0 }}>
          <h2>From outside the project</h2>
          <p className="muted small" style={{ marginTop: 0 }}>{domain ? <>Any S3 tool can use <span className="mono">{publicUrl}</span> as its endpoint with the values from Connect (Show values), for example:</> : 'Without a web address only apps in the project reach it. Turn one on in Settings to use S3 tools from your computer, for example:'}</p>
          <ul className="small">
            <li><span className="mono">aws s3 ls s3://{club.s3Buckets[0]?.name ?? 'files'} --endpoint-url {publicUrl ?? 'https://…'}</span></li>
            <li><span className="mono">mc alias set {club.name} {publicUrl ?? 'https://…'} KEY SECRET</span></li>
          </ul>
          <p className="muted small">Backups copy every bucket&apos;s files; restoring one puts the whole storage back as it was.</p>
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
