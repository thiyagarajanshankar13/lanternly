import Link from 'next/link'
import { pluginOn } from '@/plugins'
import { requireOwner } from '@/lib/guards'
import { listClubs } from '@/lib/clubs'
import { getSettings } from '@/lib/settings'
import { ActionForm } from '@/components/ActionForm'
import { SubmitButton } from '@/components/SubmitButton'
import { ActionButton, Popup, Toolbar } from '@/components/Popup'
import { fmtTime } from '@/components/ui'
import { bucketUsage, clubNs, listBackups, listImages } from '@/lib/backups/records'
import { lastScheduled } from '@/lib/backups/scheduler'
import { FREQUENT_CHOICES, KEEP_CHOICES, dueKind, fmtBytes, hourLabel, overdueAfterMs, scheduleLabel } from '@/lib/backups/schedule'
import { backupStore } from '@/lib/backups/store'
import { isFakeEngine } from '@/lib/engine'
import { keySavedAction, saveBucketAction, showKeyAction, testBucketAction } from './actions'

export const metadata = { title: 'Backups' }

/** Lightsail bucket plans (US$ a month), smallest first: the page suggests the one that fits. */
const PLANS = [{ gb: 5, price: 1 }, { gb: 100, price: 3 }, { gb: 250, price: 5 }]

export default async function BackupsPage() {
  await requireOwner()
  const s = getSettings()
  const configured = !!backupStore()
  const clubs = listClubs().filter((c) => c.kind !== 'app') // apps keep nothing to back up
  const usage = bucketUsage()
  const images = listImages()
  const usedGb = usage.total / 1024 ** 3
  const aws = pluginOn('aws')
  const plan = PLANS.find((p) => usedGb < p.gb * 0.8) ?? PLANS[PLANS.length - 1]
  const now = new Date()

  const rows = clubs.map((c) => {
    const backups = listBackups({ clubId: c.id, limit: 200 })
    const newest = backups.find((b) => b.status === 'ready')
    const last = backups[0]
    const limit = overdueAfterMs(c)
    const overdue = c.status === 'running' && limit !== null && now.getTime() - new Date(newest?.startedAt ?? c.createdAt).getTime() > limit
    const due = c.status === 'running' ? dueKind(c, lastScheduled(backups, now), now) : null
    return { c, newest, last, overdue, due, count: backups.filter((b) => b.status === 'ready').length, bytes: usage.byNs.get(clubNs(c)) ?? 0 }
  })

  return (
    <>
      <div className="page-head"><div><h1>Backups</h1>
        <p className="muted">Every site backs up to {configured ? <>the <strong>{backupStore()!.label}</strong></> : 'an S3-style bucket'} on its own schedule: database, uploaded files, keys and the version it runs. Old backups are deleted when their keep period ends.</p></div>
        <Toolbar>
          {configured && <ActionButton action={testBucketAction} label="Test the bucket" short="Test" busy="Testing…" icon="check" />}
          {s.backupKey && s.backupKeySaved && (
            <Popup label="Show backup key" short="Key" icon="key" sticky subtitle="Everything in the bucket is encrypted with the backup key you saved when backups were set up. To see it again, enter a two-step code.">
              <ActionForm action={showKeyAction} submit="Show the key" busy="Checking…">
            <div className="field"><label htmlFor="key-code">Your two-step code</label><input id="key-code" name="code" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={7} style={{ maxWidth: 140 }} /></div>
          </ActionForm>
            </Popup>
          )}
          <Popup label={configured ? 'Bucket settings' : 'Set up the bucket'} short={configured ? 'Bucket' : 'Set up'} icon="db" primary={!configured} panel subtitle="Where backups go, and the schedule new sites start with.">
            <ActionForm action={saveBucketAction} submit="Save" busy="Saving…">
          <div className="grid cols-2">
            <div className="field"><label htmlFor="backupBucket">Bucket name</label><input id="backupBucket" name="backupBucket" type="text" defaultValue={s.backupBucket} placeholder="my-backups" autoCapitalize="none" spellCheck={false} /><div className="help">The name you gave the bucket (in Lightsail: Storage).</div></div>
            <div className="field"><label htmlFor="backupRegion">Region</label><input id="backupRegion" name="backupRegion" type="text" defaultValue={s.backupRegion} /><div className="help">Sydney is <code>ap-southeast-2</code>.</div></div>
            <div className="field"><label htmlFor="backupAccessKeyId">Access key ID</label><input id="backupAccessKeyId" name="backupAccessKeyId" type="text" defaultValue={s.backupAccessKeyId} autoComplete="off" spellCheck={false} /></div>
            <div className="field"><label htmlFor="backupSecretAccessKey">Secret access key</label><input id="backupSecretAccessKey" name="backupSecretAccessKey" type="password" autoComplete="new-password" placeholder={s.backupSecretAccessKey ? 'Saved. Type to replace' : ''} /><div className="help">From the bucket&apos;s Permissions tab, &quot;Create access key&quot;. Only the deployer uses it; the sites servers never see it.</div></div>
          </div>
          <h3 style={{ marginTop: 8 }}>Schedule for new sites</h3>
          <div className="grid cols-2">
            <div className="field"><label htmlFor="backupDefaultFrequentHours">Frequent backups</label>
              <select id="backupDefaultFrequentHours" name="backupDefaultFrequentHours" defaultValue={s.backupDefaultFrequentHours}>{FREQUENT_CHOICES.map((h) => <option key={h} value={h}>{h === 0 ? 'Off' : h === 1 ? 'Every hour' : `Every ${h} hours`}</option>)}</select></div>
            <div className="field"><label htmlFor="backupDefaultFrequentKeepDays">Keep frequent backups for (days)</label>
              <select id="backupDefaultFrequentKeepDays" name="backupDefaultFrequentKeepDays" defaultValue={s.backupDefaultFrequentKeepDays}>{KEEP_CHOICES.map((d) => <option key={d} value={d}>{d}</option>)}</select></div>
            <div className="field"><label htmlFor="backupDefaultDailyHour">Daily backup at (site&apos;s time zone)</label>
              <select id="backupDefaultDailyHour" name="backupDefaultDailyHour" defaultValue={s.backupDefaultDailyHour}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}</select></div>
            <div className="field"><label htmlFor="backupDefaultDailyKeepDays">Keep daily backups for (days)</label>
              <select id="backupDefaultDailyKeepDays" name="backupDefaultDailyKeepDays" defaultValue={s.backupDefaultDailyKeepDays}>{KEEP_CHOICES.map((d) => <option key={d} value={d}>{d}</option>)}</select></div>
            <div className="field"><label htmlFor="backupRemovedKeepDays">Keep a removed site&apos;s backups for (days)</label>
              <select id="backupRemovedKeepDays" name="backupRemovedKeepDays" defaultValue={s.backupRemovedKeepDays}>{KEEP_CHOICES.map((d) => <option key={d} value={d}>{d}</option>)}</select></div>
          </div>
          <label className="small" style={{ fontWeight: 400 }}><input type="checkbox" name="backupDefaultDaily" defaultChecked={s.backupDefaultDaily} /> New sites take a daily backup</label><br />
          <label className="small" style={{ fontWeight: 400 }}><input type="checkbox" name="backupSaveImages" defaultChecked={s.backupSaveImages} /> Also keep each app version (image) a backup needs (often 0.5 GB each), so a restore works even if the image is deleted from its registry</label>
          <details style={{ marginTop: 10 }}>
            <summary className="small">Advanced</summary>
            <div className="field" style={{ marginTop: 10 }}><label htmlFor="backupEndpoint">Storage address</label><input id="backupEndpoint" name="backupEndpoint" type="text" defaultValue={s.backupEndpoint} placeholder="Leave empty for AWS (S3 or Lightsail)" /><div className="help">Only for another S3-compatible store (Cloudflare R2, Backblaze B2, Wasabi, MinIO…).</div></div>
          </details>
        </ActionForm>
            {isFakeEngine() && <p className="help">Practice mode: with only a bucket name filled in, backups go to a folder in the deployer&apos;s data folder instead.</p>}
          </Popup>
        </Toolbar>
      </div>

      {!configured && (
        <div className="notice warn">Not set up yet. Create a bucket in any S3-style store (a Lightsail bucket works well), create an access key for it, then press <strong>Set up the bucket</strong>. Until then each server only keeps a nightly database copy on its own disk.</div>
      )}

      {configured && !s.backupKeySaved && s.backupKey && (
        <div className="card" style={{ borderColor: 'var(--warn)' }}>
          <h2>Save the backup key now</h2>
          <p className="muted">Everything in the bucket is encrypted with this key. Put it in your password manager: if this deployer is ever lost, the key is the only way to read the backups (see the &quot;Reading backups without the deployer&quot; guide). It isn&apos;t shown again unless you ask with a two-step code.</p>
          <p className="mono" style={{ fontSize: 15, wordBreak: 'break-all', background: 'var(--surface-2)', padding: '10px 12px', borderRadius: 8 }}>{s.backupKey}</p>
          <form action={keySavedAction} className="row">
            <label className="small" style={{ fontWeight: 400 }}><input type="checkbox" name="saved" required /> I have saved the backup key somewhere safe</label>
            <SubmitButton className="primary">Done</SubmitButton>
          </form>
        </div>
      )}

      {configured && (
        <div className="card">
          <h2>Sites</h2>
          <div className="table-wrap"><table>
            <thead><tr><th>Site</th><th>Schedule</th><th>Last good backup</th><th>Backups</th><th>In the bucket</th><th></th></tr></thead>
            <tbody>{rows.map(({ c, newest, last, overdue, due, count, bytes }) => (
              <tr key={c.id}>
                <td><Link href={`/admin/clubs/${c.id}`}>{c.displayName}</Link> <span className="muted small mono">{c.name}</span></td>
                <td className="muted">{scheduleLabel(c)}</td>
                <td>{newest ? fmtTime(newest.startedAt) : <span className="muted">none yet</span>}</td>
                <td className="muted">{count}</td>
                <td className="muted">{fmtBytes(bytes)}</td>
                <td>
                  {last?.status === 'failed' && <span className="badge bad" title={last.error}>last one failed</span>}
                  {last?.status === 'running' && <span className="badge info">backing up</span>}
                  {overdue && <span className="badge warn" style={{ marginLeft: 4 }}>overdue</span>}
                  {due && last?.status !== 'running' && <span className="badge" style={{ marginLeft: 4 }}>due now</span>}
                  {c.status !== 'running' && <span className="muted small"> {c.status}: not backed up</span>}
                </td>
              </tr>
            ))}</tbody>
          </table></div>
          <p className="help">Bucket use (from the deployer&apos;s records): <strong>{fmtBytes(usage.total)}</strong>{images.length ? `, including ${images.length} saved app version${images.length === 1 ? '' : 's'}` : ''}. {usedGb > 0.01 && aws ? <>The {plan.gb} GB Lightsail bucket plan (about US${plan.price} a month) fits.</> : null} Uploaded files are stored once however many backups include them.</p>
        </div>
      )}


    </>
  )
}
