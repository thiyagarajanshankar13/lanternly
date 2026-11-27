import type { ServerRow } from '@/lib/engine'
import { listServers } from '@/lib/clubs'
import { displayLocale, getSettings } from '@/lib/settings'
import { ActionForm } from '@/components/ActionForm'
import { AutoRefresh } from '@/components/AutoRefresh'
import { ActionButton, Popup, Toolbar } from '@/components/Popup'
import { fmtTime } from '@/components/ui'
import { budgetCheck, DEFAULT_SIZE_GB, limitError, priceText, provisionPolicy } from '../provision/plan'
import {
  currentPlansUsd, deleteError, isBeingDeleted, lastCheck, listJobs, listSnapshots, managedCount, missingSetup, priceList, STEP_LABELS, type ServerJob,
} from '../provision/jobs'
import { costCurrency } from '../costs/service'
import { fmtMoney } from '../money'
import {
  checkLightsailAction, createServerAction, deleteManagedServerAction, discardServerJobAction, retryServerJobAction, saveProvisionSettingsAction,
} from '../serverActions'

// The AWS plugin's parts of the Servers page: making servers in Lightsail,
// following those jobs, and deleting the servers it made. The page itself
// (adding any SSH server) is core: src/app/admin/(console)/servers/page.tsx.

/** A server this plugin made (and so deletes, VM and all). */
export const madeHere = (sv: ServerRow) => !!sv.lightsail_name

function ProvisionSettings() {
  const s = getSettings()
  return (
    <ActionForm action={saveProvisionSettingsAction} submit="Save">
      <p className="small muted" style={{ marginTop: 0 }}>A separate IAM user from the costs key. Its policy (below) only lets it make VMs tagged <code>avro-managed</code>, and only change or delete VMs with that tag, in one region.</p>
      <div className="grid cols-2">
        <div className="field"><label htmlFor="pAk">Access key ID</label><input id="pAk" name="provisionAccessKeyId" type="text" className="mono" defaultValue={s.provisionAccessKeyId} placeholder="AKIA…" autoComplete="off" /></div>
        <div className="field"><label htmlFor="pSk">Secret access key</label><input id="pSk" name="provisionSecretAccessKey" type="password" placeholder={s.provisionSecretAccessKey ? '•••••••• (saved; type to replace)' : ''} autoComplete="new-password" /></div>
        <div className="field"><label htmlFor="pRegion">Region</label><input id="pRegion" name="provisionRegion" type="text" defaultValue={s.provisionRegion} /><div className="help">ap-southeast-2 is Sydney.</div></div>
        <div className="field"><label htmlFor="pZone">Zone</label><input id="pZone" name="provisionZone" type="text" defaultValue={s.provisionZone} /></div>
        <div className="field"><label htmlFor="pIp">The deployer&apos;s public IP</label><input id="pIp" name="provisionDeployerIp" type="text" defaultValue={s.provisionDeployerIp} placeholder="Looked up when empty" /><div className="help">The only address let in on SSH (port 22) of new servers, plus Lightsail&apos;s browser SSH.</div></div>
        <div className="field"><label htmlFor="pMax">Most servers the deployer may make</label><input id="pMax" name="provisionMaxServers" type="number" min={1} max={50} defaultValue={s.provisionMaxServers} /></div>
        <div className="field"><label htmlFor="pEmail">Email for HTTPS certificate notices</label><input id="pEmail" name="provisionAcmeEmail" type="email" defaultValue={s.provisionAcmeEmail} /></div>
        <div className="field"><label htmlFor="pGu">GitHub user for images</label><input id="pGu" name="provisionGhcrUser" type="text" defaultValue={s.provisionGhcrUser} /><div className="help">The same as the GHCR_USER variable of the &quot;Set up a VM&quot; workflow.</div></div>
      </div>
      <div className="field"><label htmlFor="pGt">Package token (read:packages)</label><input id="pGt" name="provisionGhcrToken" type="password" placeholder={s.provisionGhcrToken ? '•••••••• (saved; type to replace)' : 'ghp_…'} autoComplete="new-password" /><div className="help">So new servers can pull private images from GitHub's registry (ghcr.io). Optional when every image is public.</div></div>
      <details style={{ marginBottom: 12 }}>
        <summary className="small">IAM policy for this key</summary>
        <p className="small muted">In AWS: IAM &gt; Users &gt; Create user (for example <code>avro-provision</code>), then Add permissions &gt; Create inline policy &gt; JSON, and paste this. Then Security credentials &gt; Create access key.</p>
        <pre className="log" style={{ maxHeight: 260 }}>{provisionPolicy(s.provisionRegion)}</pre>
      </details>
    </ActionForm>
  )
}

async function CreateServer() {
  const missing = missingSetup()
  if (missing.length) {
    return (
      <div>
        <p style={{ marginTop: 0 }}>Before the deployer can make servers:</p>
        <ul className="small">{missing.map((m) => <li key={m}>{m}</li>)}</ul>
        <p className="small muted">Fill these in under &quot;AWS for new servers&quot;.</p>
      </div>
    )
  }
  const s = getSettings()
  const locale = displayLocale()
  const { options, rate, currency, rateNote, error } = await priceList()
  if (error) return <div className="notice bad">{error}</div>
  const limit = limitError(managedCount(), s.provisionMaxServers)
  const plansUsd = currentPlansUsd()
  // The budget is in the chosen currency; prices shown in another one (no rate to hand) aren't compared with it.
  const budget = currency === costCurrency() ? s.costBudget : 0
  const money = (n: number) => fmtMoney(n, currency, locale)
  const checks = new Map(options.map((o) => [o.ramGb, budgetCheck({ currentUsd: plansUsd ?? 0, addUsd: o.bundle.priceUsd, rate, budget, currency, locale })]))
  const anyOver = [...checks.values()].some((c) => c.over)
  const first = checks.get(DEFAULT_SIZE_GB) ?? [...checks.values()][0]
  return (
    <ActionForm action={createServerAction} submit="Create server" busy="Starting…">
      {limit && <div className="notice warn">{limit}</div>}
      <div className="field"><label htmlFor="cName">Name</label><input id="cName" name="name" type="text" required maxLength={40} placeholder={`Server ${listServers().length + 1}`} /><div className="help">Shown in the deployer. In Lightsail the VM is called avro-&lt;name&gt;.</div></div>
      <div className="field"><label>Size</label>
        <div className="role-pick">
          {options.map((o) => (
            <label key={o.ramGb}>
              <input type="radio" name="ramGb" value={o.ramGb} defaultChecked={o.ramGb === DEFAULT_SIZE_GB} />
              <span>
                <strong>{o.ramGb} GB · {priceText(o.bundle.priceUsd, rate, currency, locale)} a month</strong>
                <span className="muted small">{o.bundle.cpus} vCPU, {o.bundle.diskGb} GB disk, {o.bundle.transferGb.toLocaleString(locale)} GB transfer. Fits {o.fits}.{plansUsd !== null ? ` All plans then ${money(checks.get(o.ramGb)!.afterCost)} a month${checks.get(o.ramGb)!.over ? ', over the budget' : ''}.` : ''}</span>
              </span>
            </label>
          ))}
        </div>
        <div className="help">US$ prices from Lightsail{currency === 'USD' ? '' : `, shown at ${rateNote}`}. The static IP is free while attached. Ubuntu 24.04 in {s.provisionZone}.</div>
      </div>
      <div className="field"><label htmlFor="cMax">Most sites it may hold (optional)</label><input id="cMax" name="maxClubs" type="number" min={1} max={500} placeholder="The size's usual number" /><div className="help">A 1 GB server always holds one app and never gets sites.</div></div>
      <p className="small muted">{plansUsd === null ? "Costs hasn't fetched from AWS yet, so the budget can't be checked." : `Every Lightsail plan today: ${money(first?.nowCost ?? 0)} a month. ${budget > 0 ? `Budget ${money(budget)}.` : 'No budget set (Costs).'}`}</p>
      {budget > 0 && anyOver && (
        <label className="small" style={{ fontWeight: 400, display: 'block', marginBottom: 10 }}><input type="checkbox" name="overBudget" /> Go over the budget (needed for the sizes marked &quot;over the budget&quot;)</label>
      )}
      <p className="small muted">Takes about 10 minutes. The deployer makes the VM, gives it a static IP, opens ports 80 and 443 (SSH only from the deployer), runs the server setup and checks it can reach it, then the server takes new sites.</p>
    </ActionForm>
  )
}

function JobCard({ job }: { job: ServerJob }) {
  const tz = getSettings().defaultTimezone
  const badge = job.status === 'running' ? 'info' : job.status === 'ready' ? 'ok' : job.status === 'failed' ? 'bad' : ''
  const word = job.status === 'running' ? (job.kind === 'create' ? 'Creating' : 'Deleting') : job.status === 'ready' ? (job.kind === 'create' ? 'Ready' : 'Deleted') : job.status === 'failed' ? 'Failed' : 'Discarded'
  const canRetry = job.status === 'failed' && !(job.kind === 'create' && (job.step === 'booting' || job.step === 'setup'))
  return (
    <div className="card">
      <div className="card-head">
        <div><h2>{job.name} <span className={`badge ${badge}`}>{word}</span></h2>
          <span className="muted small">{job.kind === 'create' ? `${job.ramGb} GB` : 'Delete'} · {job.lightsailName} · {job.status === 'running' ? STEP_LABELS[job.step] ?? job.step : `finished ${fmtTime(job.finishedAt, tz)}`} · by {job.createdBy}</span></div>
        {job.status === 'failed' && (
          <Toolbar>
            {canRetry && <ActionButton action={retryServerJobAction} label="Retry" icon="refresh" busy="Retrying…"><input type="hidden" name="id" value={job.id} /></ActionButton>}
            {job.kind === 'create' && <ActionButton action={discardServerJobAction} label="Discard" icon="trash" busy="Discarding…"><input type="hidden" name="id" value={job.id} /></ActionButton>}
          </Toolbar>
        )}
      </div>
      <pre className="log">{job.log}</pre>
    </div>
  )
}

/** Toolbar buttons (only while the plugin is on). */
export function AwsServersToolbar() {
  const s = getSettings()
  return (
    <>
      <Popup label="Create server" icon="plus" primary panel title="Create a server" subtitle="A new Lightsail VM, set up and added here.">
        <CreateServer />
      </Popup>
      <Popup label="AWS for new servers" short="AWS" icon="key" panel title="AWS for new servers" subtitle="The key, limits and what new servers are set up with.">
        <ProvisionSettings />
      </Popup>
      {s.provisionAccessKeyId && <ActionButton action={checkLightsailAction} label="Check Lightsail" icon="eye" busy="Checking…" />}
    </>
  )
}

/** Above the list: the daily check's findings and creates or deletes still going (or failed). */
export function AwsServersNotices() {
  const s = getSettings()
  const jobs = listJobs(15)
  const open = jobs.filter((j) => j.status === 'running' || j.status === 'failed')
  const check = lastCheck()
  return (
    <>
      {jobs.some((j) => j.status === 'running') && <AutoRefresh seconds={5} />}
      {check && check.unknown.length > 0 && (
        <div className="notice warn">Lightsail has {check.unknown.length === 1 ? 'a VM' : `${check.unknown.length} VMs`} tagged as made by the deployer that {check.unknown.length === 1 ? 'isn\'t a server' : 'aren\'t servers'} here: {check.unknown.join(', ')}. {check.unknown.length === 1 ? 'It still costs' : 'They still cost'} money: add {check.unknown.length === 1 ? 'it' : 'them'} with &quot;Add existing server&quot;, or delete {check.unknown.length === 1 ? 'it' : 'them'} in Lightsail. (Checked {fmtTime(check.at, s.defaultTimezone)}.)</div>
      )}
      {check?.error && <div className="notice bad">The daily Lightsail check failed: {check.error}</div>}
      {open.map((j) => <JobCard key={j.id} job={j} />)}
    </>
  )
}

/** True while there are creates or deletes going or failed, so the page doesn't say "no servers yet". */
export const awsServersBusy = () => listJobs(15).some((j) => j.status === 'running' || j.status === 'failed')

/** After the server's places and memory: who made it and what it costs. */
export async function AwsServerNote({ server }: { server: ServerRow }) {
  if (!madeHere(server)) return null
  const deleting = isBeingDeleted(server.id)
  let price = ''
  if (server.price_usd) {
    const { rate, currency } = await priceList().catch(() => ({ rate: 1, currency: 'USD' as const }))
    price = `, ${priceText(server.price_usd, rate, currency, displayLocale())} a month`
  }
  return <>{` · made by the deployer (${server.lightsail_name}${price})`}{deleting && <> <span className="badge warn">Deleting</span></>}</>
}

/** In the server's Edit popup: deleting the VM this plugin made. */
export function AwsServerDelete({ server }: { server: ServerRow }) {
  if (!madeHere(server) || isBeingDeleted(server.id)) return null
  const delErr = deleteError(server)
  return (
    <div className="danger-zone">
      <h3 style={{ marginTop: 0 }}>Delete this server</h3>
      {delErr ? <p className="small muted">{delErr}</p> : (
        <ActionForm action={deleteManagedServerAction} submit="Delete server" busy="Starting…" danger>
          <input type="hidden" name="id" value={server.id} />
          <p className="small">Takes a last snapshot (kept 14 days, about US$0.05 per GB a month), deletes the VM in Lightsail and releases its static IP. Anything still pointing at {server.public_ip || 'its IP'} stops working.</p>
          <div className="field"><label htmlFor={`confirm-${server.id}`}>Type {server.name} to confirm</label><input id={`confirm-${server.id}`} name="confirm" type="text" autoComplete="off" required /></div>
        </ActionForm>
      )}
    </div>
  )
}

/** Below the list: snapshots of deleted servers and earlier jobs. */
export function AwsServersFooter() {
  const s = getSettings()
  const recent = listJobs(15).filter((j) => j.status !== 'running' && j.status !== 'failed').slice(0, 5)
  const snapshots = listSnapshots()
  return (
    <>
      {snapshots.length > 0 && (
        <div className="card">
          <h2>Snapshots of deleted servers</h2>
          <p className="small muted">A new VM can be made from one in Lightsail (Snapshots tab) if something was still needed. Each is deleted automatically on the date shown.</p>
          <ul className="small">{snapshots.map((sn) => <li key={sn.snapshotName}><code>{sn.snapshotName}</code> ({sn.serverName}), kept until {new Date(sn.deleteAfter).toLocaleDateString(displayLocale(), { timeZone: s.defaultTimezone })}</li>)}</ul>
        </div>
      )}
      {recent.length > 0 && (
        <details className="card">
          <summary>Earlier creates and deletes</summary>
          <div style={{ marginTop: 12 }}>{recent.map((j) => <JobCard key={j.id} job={j} />)}</div>
        </details>
      )}
    </>
  )
}
