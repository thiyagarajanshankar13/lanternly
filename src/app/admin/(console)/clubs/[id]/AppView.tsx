import Link from 'next/link'
import { getServer, isImageApp, listClubVersions, type Club } from '@/lib/clubs'
import { imageDisplay } from '@/lib/apps/imageRef'
import { maskedLog } from '@/lib/logs'
import { clubDomains } from '@/lib/clubEnv'
import { OP_LABELS, listOperations } from '@/lib/ops'
import { getSettings } from '@/lib/settings'
import { activeBuild, listBuilds, type AppBuild } from '@/lib/apps/builds'
import { commitTitle, shaOfImage } from '@/lib/apps/config'
import { ActionForm } from '@/components/ActionForm'
import { AutoRefresh } from '@/components/AutoRefresh'
import { ClubLogs } from '@/components/ClubLogs'
import { LiveClubMemory } from '@/components/LiveServer'
import { OperationLog } from '@/components/OperationLog'
import { SubmitButton } from '@/components/SubmitButton'
import { Icon } from '@/components/Icon'
import { MoreMenu, Popup, Toolbar } from '@/components/Popup'
import { ClubBadge, OpBadge, fmtTime } from '@/components/ui'
import { addDomainAction, clubOperationAction, makePrimaryDomainAction, removeClubAction, removeDomainAction } from '../../actions'
import { appDeployAction, updateAppAction } from '../../apps/actions'
import { MoveProject } from '@/components/MoveProject'
import { DatabasePicker } from '@/components/DatabasePicker'
import { linkableIn, projectOf } from '@/lib/services'
import { linksOfApp } from '@/lib/projects'

const BUILD: Record<AppBuild['status'], [string, string]> = {
  queued: ['Starting', 'info'], building: ['Building', 'info'], done: ['Built', 'ok'], failed: ['Failed', 'bad'],
}
const short = (sha: string) => sha.slice(0, 7)
/** nginx@sha256:3f1c… → 3f1c2ab (the pulled version of an image). */
const digestOf = (image: string) => (/@sha256:([a-f0-9]{7})/.exec(image)?.[1] ?? '')

/** The page of a site that is an app (built from a GitHub repo + branch). */
export function AppView({ club, can }: { club: Club; can: { operate: boolean; owner: boolean } }) {
  const settings = getSettings()
  const server = getServer(club.serverId)
  const domains = clubDomains(club, settings.baseDomain)
  const subdomain = `${club.name}.${settings.baseDomain}`
  const ops = listOperations({ clubId: club.id, limit: 15 })
  const latest = ops[0]
  const opBusy = !!latest && (latest.status === 'queued' || latest.status === 'running')
  const building = activeBuild(club.id)
  const busy = opBusy || !!building
  const builds = listBuilds(club.id, 8)
  const lastBuild = builds[0]
  const usable = club.status === 'running' || club.status === 'paused'
  // A failed create can still have its settings fixed before trying again.
  const failed = club.status === 'failed'
  const versions = listClubVersions(club.id)
  const repoUrl = `https://github.com/${club.appRepo}`
  const runningSha = shaOfImage(club.image)
  const secretKeys = Object.keys(club.secrets.appSecretEnv ?? {})
  const project = projectOf(club)
  const linkable = project ? linkableIn(project.id) : []
  const dbs = linkable.filter((d) => d.kind === 'postgres')
  const stores = linkable.filter((d) => d.kind === 'minio')
  const links = linksOfApp(club.id)
  const img = isImageApp(club)
  const pub = club.appPublic
  const inside = `${club.name}:${club.appPort}`
  const imageName = img ? imageDisplay(club.appImageRef) : ''

  const settingsPopup = (
    <Popup label="Settings" icon="sliders" panel subtitle={failed ? 'Save, then press Build and try again.' : 'Saving restarts the app to apply the changes (a few seconds).'}>
      <ActionForm action={updateAppAction} submit={failed ? 'Save' : 'Save and apply'} busy="Saving…">
        <input type="hidden" name="id" value={club.id} />
        <div className="field"><label htmlFor="displayName">Name</label><input id="displayName" name="displayName" type="text" defaultValue={club.displayName} required maxLength={80} /></div>
        {img && <>
          <div className="field"><label htmlFor="imageRef">Image</label><input id="imageRef" name="imageRef" type="text" defaultValue={imageName} required spellCheck={false} autoCapitalize="none" /><div className="help">Changing it pulls and deploys the new image.</div></div>
          <div className="grid cols-2">
            <div className="field"><label htmlFor="registryUser">Registry user (private images)</label><input id="registryUser" name="registryUser" type="text" defaultValue={club.secrets.registryUser ?? ''} autoComplete="off" spellCheck={false} /></div>
            <div className="field"><label htmlFor="registryToken">Access token</label><input id="registryToken" name="registryToken" type="password" autoComplete="new-password" placeholder={club.secrets.registryToken ? 'Saved (type to replace)' : ''} /></div>
          </div>
          <label className="small" style={{ fontWeight: 400, marginBottom: 14 }}><input type="checkbox" name="appPublic" defaultChecked={pub} /> Give it a web address (<span className="mono">{subdomain}</span>) with HTTPS</label>
        </>}
        <div className="grid cols-2">
          {!img && <div className="field"><label htmlFor="appBranch">Branch</label><input id="appBranch" name="appBranch" type="text" defaultValue={club.appBranch} required spellCheck={false} autoCapitalize="none" /><div className="help">Changing it builds and deploys that branch.</div></div>}
          {!img && <div className="field"><label htmlFor="appDockerfile">Dockerfile</label><input id="appDockerfile" name="appDockerfile" type="text" defaultValue={club.appDockerfile} spellCheck={false} /></div>}
          <div className="field"><label htmlFor="appPort">Port</label><input id="appPort" name="appPort" type="number" min={1} max={65535} defaultValue={club.appPort} required /></div>
          <div className="field"><label htmlFor="appHealthPath">Health page</label><input id="appHealthPath" name="appHealthPath" type="text" defaultValue={club.appHealthPath} spellCheck={false} placeholder={img ? 'none: running is enough' : '/'} /></div>
          <div className="field"><label htmlFor="memoryMb">Memory limit (MB)</label><input id="memoryMb" name="memoryMb" type="number" min={64} max={4000} defaultValue={club.memoryMb} /></div>
        </div>
        {!img && <label className="small" style={{ fontWeight: 400, marginBottom: 14 }}><input type="checkbox" name="appAutoDeploy" defaultChecked={club.appAutoDeploy} /> Deploy every push to the branch by itself</label>}
        <DatabasePicker databases={linkable.map((d) => ({ id: d.id, name: d.name, displayName: d.displayName, kind: d.kind, buckets: d.s3Buckets.map((b) => b.name) }))} linked={links.map((l) => ({ dbId: l.dbId, prefix: l.prefix, bucket: l.bucket }))} />
        <div className="field"><label htmlFor="extraEnv">Settings</label><textarea id="extraEnv" name="extraEnv" defaultValue={club.extraEnv} spellCheck={false} /><div className="help">One KEY=value per line, given to the app as environment variables.{dbs.length ? <> A value can use a database of this project: <span className="mono">{'${{'}{dbs[0].name}.DATABASE_URL{'}}'}</span>.</> : null}{stores.length ? <> Or a storage: <span className="mono">{'${{'}{stores[0].name}.S3_SECRET_ACCESS_KEY{'}}'}</span>.</> : null}</div></div>
        <div className="field"><label htmlFor="appPredeploy">Pre-deploy command (optional)</label><input id="appPredeploy" name="appPredeploy" type="text" defaultValue={club.appPredeploy} maxLength={500} spellCheck={false} placeholder="npm run migrate" />
          <div className="help">Runs once in each new version, with its settings, before it takes over (database migrations). If it fails, the version already running stays.</div></div>
        <div className="field"><label htmlFor="secretEnv">Secret settings</label><textarea id="secretEnv" name="secretEnv" spellCheck={false} autoComplete="off" placeholder={secretKeys.length ? `Saved: ${secretKeys.join(', ')}` : 'SMTP_PASS=…'} />
          <div className="help">Saved ones aren&apos;t shown. A KEY=value line adds or replaces one; <code>KEY=</code> with nothing after it removes it.</div></div>
        <div className="field"><label htmlFor="notes">Notes (only shown here)</label><textarea id="notes" name="notes" defaultValue={club.notes} style={{ fontFamily: 'inherit', fontSize: 'inherit' }} /></div>
      </ActionForm>
    </Popup>
  )

  return (
    <>
      {busy && <AutoRefresh seconds={5} />}
      <div className="page-head">
        <div>
          <p className="small" style={{ marginBottom: 4 }}><Link href="/admin/services">← Sites</Link>{project ? <> · <Link href={`/admin/projects/${project.id}`}>{project.displayName}</Link></> : null}</p>
          <h1>{club.displayName} <ClubBadge status={club.status} /> <span className="badge">{img ? 'Image' : 'App'}</span></h1>
          <p className="muted">
            {pub ? <a href={`https://${domains[0]}`} target="_blank" rel="noreferrer">{domains[0]}</a> : <>Inside the project at <span className="mono">{inside}</span>; no web address</>}
            {' · '}
            {img ? <span className="mono">{imageName}</span> : <a href={`${repoUrl}/tree/${club.appBranch}`} target="_blank" rel="noreferrer">{club.appRepo} @ {club.appBranch}</a>}
          </p>
        </div>
        <Toolbar>
          {pub && <a className="btn" href={`https://${domains[0]}`} target="_blank" rel="noreferrer"><Icon name="ext" size={16} /><span className="tb-label">Open site</span></a>}
          {can.operate && usable && !busy && (
            <>
              <form action={appDeployAction}><input type="hidden" name="id" value={club.id} /><input type="hidden" name="kind" value="latest" />
                <SubmitButton className="primary" busy="Starting…"><Icon name="rocket" size={16} /><span className="tb-label">{img ? 'Pull again' : 'Deploy latest'}</span></SubmitButton></form>
              {club.status === 'running' ? (
                <form action={clubOperationAction}><input type="hidden" name="id" value={club.id} /><input type="hidden" name="kind" value="pause" /><SubmitButton busy="Queuing…"><Icon name="pause" size={16} /><span className="tb-label">Pause</span></SubmitButton></form>
              ) : (
                <form action={clubOperationAction}><input type="hidden" name="id" value={club.id} /><input type="hidden" name="kind" value="resume" /><SubmitButton busy="Queuing…"><Icon name="play" size={16} /><span className="tb-label">Resume</span></SubmitButton></form>
              )}
              <span className="tb-sep" />
              {settingsPopup}
            </>
          )}
          {can.operate && failed && !busy && settingsPopup}
          {can.operate && !busy && club.status !== 'removing' && (
            <MoreMenu>
              {usable && pub && (
                <Popup menu label="Add a custom domain" icon="globe">
                  <p className="muted small">
                    First, at the domain&apos;s DNS provider, add one record. For a subdomain such as <code>www</code>: a <strong>CNAME</strong> to <code>{subdomain}</code>.
                    {server?.public_ip ? <> For the bare domain: an <strong>A</strong> record to <code>{server.public_ip}</code>.</> : null} Then add it here.
                  </p>
                  <ActionForm action={addDomainAction} submit="Add domain" busy="Checking…">
                    <input type="hidden" name="id" value={club.id} />
                    <div className="field"><label htmlFor="domain">Domain</label><input id="domain" name="domain" type="text" placeholder="www.example.com" autoCapitalize="none" spellCheck={false} required /></div>
                    <label className="small" style={{ fontWeight: 400 }}><input type="checkbox" name="force" /> Add anyway, even if the DNS record isn&apos;t visible yet</label>
                  </ActionForm>
                </Popup>
              )}
              {can.owner && usable && <MoveProject club={club} />}
              {can.owner && usable && <hr />}
              {can.owner && <Popup menu danger label="Remove this app…" title="Remove this app" icon="trash">
                <p className="muted">Stops the app and deletes it from the server. {img ? 'The image stays in its registry' : 'Its code stays in GitHub'} and its settings are kept in a folder on the server. This can&apos;t be undone from here.</p>
                <ActionForm action={removeClubAction} submit="Remove app" busy="Removing…" danger>
                  <input type="hidden" name="id" value={club.id} />
                  <div className="field"><label htmlFor="confirm">Type <span className="mono">{club.name}</span> to confirm</label><input id="confirm" name="confirm" type="text" autoComplete="off" style={{ maxWidth: 260 }} /></div>
                  {club.status === 'failed' && <label className="small" style={{ fontWeight: 400 }}><input type="checkbox" name="recordOnly" defaultChecked /> It was never created: just delete this record</label>}
                </ActionForm>
              </Popup>}
            </MoreMenu>
          )}
        </Toolbar>
      </div>

      {building && (
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
            <h2 style={{ margin: 0 }}>Building {short(building.sha)}</h2>
            <span className={`badge ${BUILD[building.status][1]}`}>{BUILD[building.status][0]}</span>
          </div>
          <p className="muted" style={{ margin: 0 }}>
            “{commitTitle(building.message) || 'No commit message'}”. GitHub is building the image from the Dockerfile; the app {building.reason === 'create' ? 'is created' : 'switches over'} as soon as it is ready.
            {building.runUrl ? <> <a href={building.runUrl} target="_blank" rel="noreferrer">Watch the build on GitHub</a>.</> : ' Waiting for GitHub to start it…'}
          </p>
        </div>
      )}

      {!building && lastBuild?.status === 'failed' && (!latest || new Date(lastBuild.createdAt) >= new Date(latest.createdAt)) && (
        <div className="notice bad">
          The build of {short(lastBuild.sha)} failed: {lastBuild.error}{lastBuild.runUrl ? <> <a href={lastBuild.runUrl} target="_blank" rel="noreferrer">Open the GitHub log</a>.</> : null}
          {club.status === 'running' ? ' The app keeps running its current version.' : ''}
        </div>
      )}

      {latest && (opBusy || latest.status === 'failed') && (
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
            <h2 style={{ margin: 0 }}>{OP_LABELS[latest.kind]}</h2>
            <OpBadge status={latest.status} />
          </div>
          <OperationLog key={latest.id} id={latest.id} initialStatus={latest.status} initialLog={maskedLog(latest.log, club)} />
        </div>
      )}

      {can.owner && failed && !busy && (
        <div className="card">
          <h2>This app wasn&apos;t created</h2>
          <p className="muted">{img ? 'Read the output above, fix the cause (the image name, its sign-in, the port or the settings), then try again.' : 'Read the build log or the output above, fix the cause in the repo (or the settings), then try again.'}</p>
          <form action={appDeployAction}><input type="hidden" name="id" value={club.id} /><input type="hidden" name="kind" value="retry-create" /><SubmitButton className="primary">{img ? 'Try again' : 'Build and try again'}</SubmitButton></form>
        </div>
      )}

      <div className="grid cols-2">
        <div className="card" style={{ marginBottom: 0 }}>
          <h2>About</h2>
          <dl className="facts">
            <dt>Name</dt><dd className="mono">{club.name}</dd>
            {img ? <>
              <dt>Image</dt><dd><span className="mono">{imageName}</span>{club.secrets.registryUser ? <span className="muted"> · private, signed in as {club.secrets.registryUser}</span> : null}</dd>
              <dt>Running</dt><dd>{digestOf(club.image) ? <span className="mono" title={club.image}>sha256:{digestOf(club.image)}</span> : '–'}{versions[0]?.note ? <span className="muted"> · {versions[0].note}</span> : null}</dd>
              <dt>Updates</dt><dd>When you press Pull again or change the image{club.appImageRef.endsWith(':latest') ? <span className="muted"> (tip: a version tag such as :1.27 instead of :latest keeps each pull the same)</span> : null}</dd>
              <dt>Address</dt><dd>{pub ? <>{domains[0]} <span className="muted">· inside the project</span> <span className="mono">{inside}</span></> : <><span className="mono">{inside}</span> <span className="muted">(inside the project only)</span></>}</dd>
            </> : <>
              <dt>Code</dt><dd><a href={`${repoUrl}/tree/${club.appBranch}`} target="_blank" rel="noreferrer">{club.appRepo}</a> · branch <span className="mono">{club.appBranch}</span></dd>
              <dt>Running</dt><dd>{runningSha ? <a className="mono" href={`${repoUrl}/commit/${runningSha}`} target="_blank" rel="noreferrer">{short(runningSha)}</a> : '–'}{versions[0]?.note ? <span className="muted"> · {versions[0].note}</span> : null}</dd>
              <dt>Deploys</dt><dd>{club.appAutoDeploy ? 'Every push to the branch' : 'Only when you press Deploy latest'}</dd>
            </>}
            <dt>Port · health</dt><dd><span className="mono">{club.appPort}</span> · {club.appHealthPath ? <span className="mono">{club.appHealthPath}</span> : <span className="muted">no health page (running is enough)</span>}</dd>
            <dt>Server</dt><dd>{server?.name ?? 'missing'}</dd>
            <dt>Memory</dt><dd>{server && usable ? <LiveClubMemory serverId={server.id} name={club.name} /> : '–'} <span className="muted">(limit {club.memoryMb} MB)</span></dd>
            <dt>Project</dt><dd>{project ? <Link href={`/admin/projects/${project.id}`}>{project.displayName}</Link> : '–'}</dd>
            <dt>Databases</dt><dd>{links.some((l) => dbs.some((d) => d.id === l.dbId)) ? dbs.flatMap((d) => links.filter((l) => l.dbId === d.id).map((l) => ({ d, l }))).map(({ d, l }, i) => <span key={d.id}>{i ? ', ' : ''}<Link href={`/admin/clubs/${d.id}`}>{d.name}</Link>{l.prefix ? <span className="muted mono small"> {l.prefix}…</span> : null}</span>) : <span className="muted">None connected</span>}</dd>
            {stores.length > 0 && <><dt>Storage</dt><dd>{links.some((l) => stores.some((d) => d.id === l.dbId)) ? stores.flatMap((d) => links.filter((l) => l.dbId === d.id).map((l) => ({ d, l }))).map(({ d, l }, i) => <span key={d.id}>{i ? ', ' : ''}<Link href={`/admin/clubs/${d.id}`}>{d.name}</Link><span className="muted mono small"> {l.bucket || d.s3Buckets[0]?.name}{l.prefix ? ` · ${l.prefix}…` : ''}</span></span>) : <span className="muted">None connected</span>}</dd></>}
            {club.appPredeploy && <><dt>Pre-deploy</dt><dd className="mono small">{club.appPredeploy}</dd></>}
            <dt>Settings</dt><dd>{club.extraEnv.trim() ? club.extraEnv.split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => l.slice(0, l.indexOf('='))).join(', ') : 'None'}{secretKeys.length ? <span className="muted"> · secret: {secretKeys.join(', ')}</span> : null}</dd>
            <dt>Backups</dt><dd className="muted">{img ? 'Nothing to back up: the image is in its registry and the settings live here. It keeps no files: data belongs in a database.' : 'Nothing to back up: the code is in GitHub, the built versions are kept and the settings live here.'}</dd>
            <dt>Created</dt><dd>{fmtTime(club.createdAt)}</dd>
          </dl>
        </div>

        {!pub ? (
          <div className="card" style={{ marginBottom: 0 }}>
            <h2>Addresses</h2>
            <p className="muted">No web address: only the other services of {project ? <Link href={`/admin/projects/${project.id}`}>{project.displayName}</Link> : 'its project'} can reach it, at <span className="mono">{inside}</span>.</p>
            {can.operate && <p className="help">To put it on the web, tick &quot;Give it a web address&quot; in Settings.</p>}
          </div>
        ) : (
        <div className="card" style={{ marginBottom: 0 }}>
          <h2>Addresses</h2>
          <table>
            <tbody>
              {domains.map((d, i) => (
                <tr key={d}>
                  <td className="wrap"><a href={`https://${d}`} target="_blank" rel="noreferrer">{d}</a>{i === 0 && <span className="badge info" style={{ marginLeft: 6 }}>main</span>}</td>
                  <td style={{ textAlign: 'right' }}>
                    {can.operate && d !== subdomain && usable && !busy && (
                      <span className="row end">
                        {i !== 0 && <form action={makePrimaryDomainAction}><input type="hidden" name="id" value={club.id} /><input type="hidden" name="domain" value={d} /><SubmitButton>Make main</SubmitButton></form>}
                        <form action={removeDomainAction}><input type="hidden" name="id" value={club.id} /><input type="hidden" name="domain" value={d} /><SubmitButton>Remove</SubmitButton></form>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {club.customDomains.length > 0 && (
            <div className="row" style={{ marginTop: 12, alignItems: 'center' }}>
              <p className="help" style={{ margin: 0, flex: 1 }}>A custom domain gets its HTTPS certificate once its DNS record points at this server. If it was added before that, the server waits longer before each retry: press Retry HTTPS after fixing DNS.</p>
              {can.operate && usable && !busy && <form action={clubOperationAction}><input type="hidden" name="id" value={club.id} /><input type="hidden" name="kind" value="https" /><SubmitButton busy="Queuing…">Retry HTTPS</SubmitButton></form>}
            </div>
          )}
          {can.operate && <p className="help">Add a custom domain from the More menu.</p>}
        </div>
        )}
      </div>

      {usable && (
        <div className="card" style={{ marginTop: 16 }}>
          <h2>Logs</h2>
          <ClubLogs clubId={club.id} name={club.name} />
        </div>
      )}

      {versions.length > 0 && (
        <div className="card" style={{ marginTop: usable ? 0 : 16 }}>
          <h2>Versions</h2>
          <div className="table-wrap"><table>
            <thead><tr><th>{img ? 'Version' : 'Commit'}</th><th>Since</th><th>By</th><th></th></tr></thead>
            <tbody>{versions.map((v, i) => {
              const sha = img ? digestOf(v.image) : shaOfImage(v.image)
              return (
                <tr key={v.id}>
                  <td className="wrap">
                    {img ? <span className="mono" title={v.image}>{sha ? `sha256:${sha}` : v.image}</span> : sha ? <a className="mono" href={`${repoUrl}/commit/${sha}`} target="_blank" rel="noreferrer">{short(sha)}</a> : <span className="mono">{v.image}</span>}
                    {i === 0 && v.image === club.image && <span className="badge ok" style={{ marginLeft: 6 }}>now</span>}
                    {v.note && <div className="muted small">{v.note}</div>}
                  </td>
                  <td className="muted">{fmtTime(v.at)}</td>
                  <td className="muted">{v.by || '–'}</td>
                  <td style={{ textAlign: 'right' }}>{can.operate && usable && !busy && v.image !== club.image && (
                    <form action={appDeployAction}><input type="hidden" name="id" value={club.id} /><input type="hidden" name="kind" value="rollback" /><input type="hidden" name="image" value={v.image} />
                      <SubmitButton>Roll back to {short(sha || v.image)}</SubmitButton></form>
                  )}</td>
                </tr>
              )
            })}</tbody>
          </table></div>
          <p className="help">{img ? 'Each version is the exact image pulled then, so rolling back gets it again (as long as the registry still has it).' : 'Rolling back starts that version again (no new build). The 10 newest builds are kept on GitHub.'}</p>
        </div>
      )}

      {builds.length > 0 && (
        <div className="card">
          <h2>Builds</h2>
          <div className="table-wrap"><table>
            <thead><tr><th>Commit</th><th>Result</th><th>When</th><th>By</th><th></th></tr></thead>
            <tbody>{builds.map((b) => (
              <tr key={b.id}>
                <td className="wrap"><a className="mono" href={`${repoUrl}/commit/${b.sha}`} target="_blank" rel="noreferrer">{short(b.sha)}</a><div className="muted small">{commitTitle(b.message)}</div></td>
                <td><span className={`badge ${BUILD[b.status][1]}`}>{BUILD[b.status][0]}</span>{b.status === 'failed' && b.error ? <div className="muted small">{b.error}</div> : null}</td>
                <td className="muted">{fmtTime(b.createdAt)}</td>
                <td className="muted">{b.createdBy}</td>
                <td>{b.runUrl && <a href={b.runUrl} target="_blank" rel="noreferrer">GitHub log</a>}</td>
              </tr>
            ))}</tbody>
          </table></div>
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
