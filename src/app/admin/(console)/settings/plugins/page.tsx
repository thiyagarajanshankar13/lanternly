import Link from 'next/link'
import { requireOwner } from '@/lib/guards'
import { ActionForm } from '@/components/ActionForm'
import { Icon } from '@/components/Icon'
import { Popup } from '@/components/Popup'
import { PLUGINS, enabledPlugins } from '@/plugins'
import { setPluginAction } from '../../actions'

export const metadata = { title: 'Plugins' }
export const dynamic = 'force-dynamic'


export default async function PluginsPage() {
  await requireOwner()
  const on = enabledPlugins()
  return (
    <>
      <div className="page-head">
        <div>
          <p className="small" style={{ marginBottom: 4 }}><Link href="/admin/settings">← Settings</Link></p>
          <h1>Plugins</h1>
          <p className="muted">A plugin adds service types, pages and settings to the deployer. Turning one off hides what it adds. Services it already made keep running on their servers.</p>
        </div>
      </div>

      {PLUGINS.map((p) => {
        const isOn = on.has(p.id)
        return (
          <section key={p.id} className="card plugin-card">
            <span className={isOn ? 'svc-icon' : 'svc-icon off'}><Icon name={p.icon} size={20} /></span>
            <div className="plugin-body">
              <h2>{p.name} <span className="muted small" style={{ fontWeight: 400 }}>{p.by}</span>{isOn ? <span className="badge ok">On</span> : <span className="badge">Off</span>}</h2>
              <p className="muted">{p.description}</p>
              <div className="plugin-adds">{p.adds.map((a) => <span key={a}>{a}</span>)}</div>
            </div>
            <div className="plugin-side">
              {isOn ? (
                <Popup label="Turn off" title={`Turn off ${p.name}?`} icon="pause">
                  <ActionForm action={setPluginAction} submit="Turn off" busy="Turning off…" danger>
                    <input type="hidden" name="plugin" value={p.id} />
                    <input type="hidden" name="on" value="off" />
                    <p className="muted" style={{ marginTop: 0 }}>{p.whenOff}</p>
                  </ActionForm>
                </Popup>
              ) : (
                <ActionForm action={setPluginAction} submit="Turn on" busy="Turning on…">
                  <input type="hidden" name="plugin" value={p.id} />
                  <input type="hidden" name="on" value="on" />
                </ActionForm>
              )}
              {isOn && p.settingsHref && <Link className="btn" href={p.settingsHref}>Plugin settings</Link>}
            </div>
          </section>
        )
      })}

      <section className="card core-card">
        <h2>Always there (not plugins)</h2>
        <p className="muted" style={{ margin: 0 }}>Projects, apps from GitHub, Docker images, PostgreSQL, any server over SSH, web addresses and HTTPS, backups to any S3-style bucket, monitoring, people and activity.</p>
      </section>
      <p className="muted small">New plugins are added to the code by a developer (in <code>src/plugins</code>), then turned on here. There is no plugin store.</p>
    </>
  )
}
