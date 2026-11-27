import { requireOwner } from '@/lib/guards'
import { clubCount, memoryUsed, listServers, reservedMb } from '@/lib/clubs'
import type { ServerRow } from '@/lib/engine'
import { serversPageParts } from '@/plugins/parts'
import { ActionForm } from '@/components/ActionForm'
import { LiveServer } from '@/components/LiveServer'
import { SubmitButton } from '@/components/SubmitButton'
import { Popup, Toolbar } from '@/components/Popup'
import { deleteServerAction, saveServerAction } from '../actions'

export const metadata = { title: 'Servers' }
export const dynamic = 'force-dynamic'

function ServerFields({ s }: { s?: ServerRow }) {
  const id = s?.id ?? 'new'
  return (
    <>
      {s && <input type="hidden" name="id" value={s.id} />}
      <div className="grid cols-2">
        <div className="field"><label htmlFor={`name-${id}`}>Name</label><input id={`name-${id}`} name="name" type="text" defaultValue={s?.name ?? ''} placeholder="Server 1" required /></div>
        <div className="field"><label htmlFor={`host-${id}`}>Address (for SSH)</label><input id={`host-${id}`} name="host" type="text" defaultValue={s?.host ?? ''} placeholder="13.54.1.2" required /></div>
        <div className="field"><label htmlFor={`ip-${id}`}>Public IP (where site domains point)</label><input id={`ip-${id}`} name="publicIp" type="text" defaultValue={s?.public_ip ?? ''} placeholder="13.54.1.2" /></div>
        <div className="field"><label htmlFor={`max-${id}`}>Most sites it may hold</label><input id={`max-${id}`} name="maxClubs" type="number" min={1} max={500} defaultValue={s?.max_clubs ?? 10} required /></div>
        <div className="field"><label htmlFor={`mem-${id}`}>Memory (MB)</label><input id={`mem-${id}`} name="memoryMb" type="number" min={1024} max={1048576} defaultValue={s?.memory_mb || ''} placeholder="8192" /><div className="help">The server&apos;s RAM. With it set, new services only go on when their memory limits fit (1 GB is kept for Postgres, Caddy and the system). Databases don&apos;t use a site place.</div></div>
        <div className="field"><label htmlFor={`port-${id}`}>SSH port</label><input id={`port-${id}`} name="port" type="number" defaultValue={s?.port ?? 22} /></div>
        <div className="field"><label htmlFor={`user-${id}`}>SSH user</label><input id={`user-${id}`} name="username" type="text" defaultValue={s?.username ?? 'deployer'} /><div className="help">Leave as <code>deployer</code>, the user the setup creates. Not <code>ubuntu</code>.</div></div>
      </div>
      <div className="field">
        <label htmlFor={`key-${id}`}>Host key</label>
        <input id={`key-${id}`} name="hostKey" type="text" defaultValue={s?.host_key ?? ''} placeholder="ssh-ed25519 AAAA…" className="mono" required />
        <div className="help">Printed at the end of setup-clubs-vm.sh. The deployer refuses to talk to a server whose key doesn&apos;t match.</div>
      </div>
      <label className="small" style={{ fontWeight: 400 }}><input type="checkbox" name="acceptsNew" defaultChecked={s ? !!s.accepts_new : true} /> Takes new sites</label>
    </>
  )
}

export default async function ServersPage() {
  await requireOwner()
  // Adding any SSH server is core; a server provider plugin (AWS: Lightsail) adds Create server and its own parts.
  const { toolbars, all } = serversPageParts()
  const servers = listServers()
  const busy = all.some((p) => p.busy?.())
  const owner = (sv: ServerRow) => all.find((p) => p.owns?.(sv))
  return (
    <>
      <div className="page-head"><div><h1>Servers</h1><p className="muted">The machines that run your services. Prepare any Ubuntu server you can reach over SSH with <code>agent/setup-clubs-vm.sh</code>, then add it{toolbars.length ? ', or create one from here' : ''}.</p></div>
        <Toolbar>
          {toolbars.map((p, i) => { const T = p.Toolbar!; return <T key={`t${i}`} /> })}
          <Popup label="Add existing server" short="Add" icon="servers" primary={!toolbars.length} panel title="Add a server" subtitle="A VM prepared with agent/setup-clubs-vm.sh.">
            <ActionForm action={saveServerAction} submit="Add server"><ServerFields /></ActionForm>
          </Popup>
        </Toolbar>
      </div>

      {all.map((p, i) => p.Notices ? <p.Notices key={`n${i}`} /> : null)}

      {servers.length === 0 && !busy && <div className="card"><p className="muted" style={{ margin: 0 }}>No servers yet. Press {toolbars.length ? '“Create server” or ' : ''}“Add existing server”.</p></div>}
      {servers.map((sv) => {
        const made = owner(sv)
        return (
          <div className="card" key={sv.id}>
            <div className="card-head">
              <div><h2>{sv.name}{sv.purpose === 'apps' && <> <span className="badge">Apps only</span></>}</h2>
                <span className="muted small">{clubCount(sv.id)} of {sv.max_clubs} places used{sv.memory_mb ? ` · ${memoryUsed(sv.id).toLocaleString('en')} of ${(sv.memory_mb - reservedMb(sv)).toLocaleString('en')} MB given out` : ''}{all.map((p, i) => p.Note ? <p.Note key={`m${i}`} server={sv} /> : null)}</span></div>
              <Popup label="Edit" icon="edit" panel title={`Edit ${sv.name}`}>
                <ActionForm action={saveServerAction} submit="Save"><ServerFields s={sv} /></ActionForm>
                {!made && clubCount(sv.id) === 0 && (
                  <form action={deleteServerAction} className="danger-zone"><input type="hidden" name="id" value={sv.id} /><SubmitButton className="danger">Delete this server&apos;s record</SubmitButton></form>
                )}
                {made?.Danger && <made.Danger server={sv} />}
              </Popup>
            </div>
            <LiveServer serverId={sv.id} />
          </div>
        )
      })}

      {all.map((p, i) => p.Footer ? <p.Footer key={`f${i}`} /> : null)}
    </>
  )
}
