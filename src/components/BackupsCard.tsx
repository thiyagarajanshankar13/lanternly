import Link from 'next/link'
import type { Club } from '@/lib/clubs'
import { KIND_LABELS, listBackups } from '@/lib/backups/records'
import { FREQUENT_CHOICES, KEEP_CHOICES, fmtBytes, hourLabel, scheduleLabel } from '@/lib/backups/schedule'
import { versionLabelFor } from '@/plugins/parts'
import { restoreAction, restoreCopyAction, saveScheduleAction } from '@/app/admin/(console)/backups/actions'
import { ActionForm } from './ActionForm'
import { Popup } from './Popup'
import { fmtTime } from './ui'

const STATUS: Record<string, [string, string]> = { ready: ['Ready', 'ok'], running: ['In progress', 'info'], failed: ['Failed', 'bad'] }

function KeepSelect({ name, value, id }: { name: string; value: number; id: string }) {
  const choices = (KEEP_CHOICES as readonly number[]).includes(value) ? KEEP_CHOICES : [...KEEP_CHOICES, value].sort((a, b) => a - b)
  return <select id={id} name={name} defaultValue={value}>{choices.map((d) => <option key={d} value={d}>{d} day{d === 1 ? '' : 's'}</option>)}</select>
}

/** The site page's backups: schedule, the list in the bucket, restore. */
/** `owner` decides whether Restore shows: restoring overwrites live data, so only owners can. */
export function BackupsCard({ club, configured, busy, owner }: { club: Club; configured: boolean; busy: boolean; owner: boolean }) {
  const backups = listBackups({ clubId: club.id, limit: 100 })
  const usable = club.status === 'running' || club.status === 'paused'
  const ready = backups.filter((b) => b.status === 'ready')
  return (
    <div className="card">
      <div className="card-head">
        <h2>Backups</h2>
        {configured && (
          <Popup label="Change schedule" title="Backup schedule" icon="clock" subtitle={`Times are in the site's time zone (${club.timezone || 'Australia/Sydney'}).`}>
            <ActionForm action={saveScheduleAction} submit="Save schedule" busy="Saving…">
                <input type="hidden" name="id" value={club.id} />
                <div className="grid cols-2">
                  <div className="field"><label htmlFor="frequentHours">Frequent backups</label>
                    <select id="frequentHours" name="frequentHours" defaultValue={club.backupFrequentHours}>
                      {FREQUENT_CHOICES.map((h) => <option key={h} value={h}>{h === 0 ? 'Off' : h === 1 ? 'Every hour' : `Every ${h} hours`}</option>)}
                    </select></div>
                  <div className="field"><label htmlFor="frequentKeepDays">Keep frequent backups for</label><KeepSelect id="frequentKeepDays" name="frequentKeepDays" value={club.backupFrequentKeepDays} /></div>
                  <div className="field"><label htmlFor="dailyHour">Daily backup at</label>
                    <select id="dailyHour" name="dailyHour" defaultValue={club.backupDailyHour}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}</select></div>
                  <div className="field"><label htmlFor="dailyKeepDays">Keep daily backups for</label><KeepSelect id="dailyKeepDays" name="dailyKeepDays" value={club.backupDailyKeepDays} /></div>
                </div>
                <label className="small" style={{ fontWeight: 400 }}><input type="checkbox" name="daily" defaultChecked={club.backupDaily} /> Take a daily backup</label>
                <p className="help">&quot;Back up now&quot;, the backup before an upgrade and the safety copy before a restore are kept as long as daily ones. The newest good backup is never deleted.</p>
              </ActionForm>
          </Popup>
        )}
      </div>
      {!configured ? (
        <p className="muted" style={{ margin: 0 }}>Backups to a bucket aren&apos;t set up yet. Until they are, the server keeps a nightly database copy on its own disk. {owner ? <Link href="/admin/backups">Set up the bucket</Link> : 'An owner can set up the bucket'}.</p>
      ) : (
        <>
          <p className="muted">Schedule: <strong>{scheduleLabel(club)}</strong> ({club.timezone || 'UTC'} time). {club.kind === 'postgres' ? 'Each backup holds the whole database (pg_dump).' : <>Each backup holds the database, every uploaded file, the site&apos;s keys and the version it runs.</>}
            {club.backupAlert === 'failed' && <> <span className="badge bad">last backup failed</span></>}
            {club.backupAlert === 'overdue' && <> <span className="badge warn">overdue</span></>}</p>

          {backups.length === 0 ? <p className="muted" style={{ marginBottom: 0 }}>No backups in the bucket yet.</p> : (
            <div className="table-wrap" style={{ marginTop: 12 }}><table>
              <thead><tr><th>Taken</th><th>What</th><th>Version</th><th>Size</th><th>Kept until</th><th></th></tr></thead>
              <tbody>{backups.map((b) => {
                const [label, tone] = STATUS[b.status] ?? [b.status, '']
                return (
                  <tr key={b.id}>
                    <td>{fmtTime(b.startedAt)} {b.status !== 'ready' && <span className={`badge ${tone}`}>{label}</span>}</td>
                    <td className="muted" title={b.error || b.note}>{KIND_LABELS[b.kind]}{b.status === 'failed' && b.error ? `: ${b.error.slice(0, 80)}` : ''}</td>
                    <td><span className="mono" title={b.image}>{b.image ? versionLabelFor(club.kind, b.image) : '–'}</span></td>
                    <td className="muted">{b.status === 'ready' ? (club.kind === 'postgres' ? fmtBytes(b.dbBytes) : `${fmtBytes(b.dbBytes)} + ${b.fileCount} files (${fmtBytes(b.fileBytes)})`) : '–'}</td>
                    <td className="muted">{b.status === 'ready' ? (b.id === ready[0]?.id ? 'newest, always kept' : fmtTime(b.keepUntil)) : ''}</td>
                    <td style={{ textAlign: 'right' }}>{owner && b.status === 'ready' && (
                      <Popup label="Restore…" title={`Backup of ${fmtTime(b.startedAt)}`} subtitle={versionLabelFor(club.kind, b.image)} panel>
                        <div className="grid cols-2">
                <div>
                  <h3>{club.kind === 'postgres' ? 'Put this database back' : 'Put this site back'}</h3>
                  {club.kind === 'postgres'
                    ? <p className="muted small">Takes a safety backup first, then loads this backup beside the live data and swaps it in (a few seconds without connections). The apps using it restart.</p>
                    : <p className="muted small">Takes a safety backup first, then replaces the site&apos;s database, uploaded files and keys with this backup and moves it to {versionLabelFor(club.kind, b.image)}. The site is offline for about a minute. If it doesn&apos;t start, it is put back as it was. Addresses and modules stay as they are now.</p>}
                  {usable && !busy ? (
                    <ActionForm action={restoreAction} submit="Restore this backup" busy="Starting…" danger>
                      <input type="hidden" name="id" value={club.id} /><input type="hidden" name="backupId" value={b.id} />
                      <div className="field"><label htmlFor={`confirm-${b.id}`}>Type <span className="mono">{club.name}</span> to confirm</label><input id={`confirm-${b.id}`} name="confirm" type="text" autoComplete="off" /></div>
                      <div className="field"><label htmlFor={`code-${b.id}`}>Your two-step code</label><input id={`code-${b.id}`} name="code" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={7} style={{ maxWidth: 140 }} /></div>
                    </ActionForm>
                  ) : <p className="muted small">{busy ? 'Wait for the current change to finish.' : 'Only a running or paused site can be restored.'}</p>}
                </div>
                <div>
                  <h3>{club.kind === 'postgres' ? 'Make a copy as a new database' : 'Make a copy at a new address'}</h3>
                  {club.kind === 'postgres'
                    ? <p className="muted small">Creates a separate database in the same project from this backup, without touching this one. No app uses it until you connect one. Remove it when you&apos;re done.</p>
                    : <p className="muted small">Creates a separate site from this backup to look at, without touching this one. Its background jobs (emails, reminders) are paused, it has no Square keys and search engines are told to stay away. Remove it when you&apos;re done.</p>}
                  <ActionForm action={restoreCopyAction} submit="Make a copy" busy="Starting…">
                    <input type="hidden" name="backupId" value={b.id} />
                    <div className="field"><label htmlFor={`name-${b.id}`}>{club.kind === 'postgres' ? 'Name of the copy' : 'Web address of the copy'}</label><input id={`name-${b.id}`} name="name" type="text" defaultValue={`${club.name.slice(0, 25)}-copy`} autoCapitalize="none" spellCheck={false} /></div>
                    <div className="field"><label htmlFor={`ccode-${b.id}`}>Your two-step code</label><input id={`ccode-${b.id}`} name="code" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={7} style={{ maxWidth: 140 }} /></div>
                  </ActionForm>
                </div>
              </div>
                      </Popup>
                    )}</td>
                  </tr>
                )
              })}</tbody>
            </table></div>
          )}

        </>
      )}
    </div>
  )
}
