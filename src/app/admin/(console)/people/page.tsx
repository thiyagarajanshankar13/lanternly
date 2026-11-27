import Link from 'next/link'
import { listAdmins } from '@/lib/auth'
import { accessSummary, roleLabel } from '@/lib/access'
import { listClubs } from '@/lib/clubs'
import { listProjects } from '@/lib/projects'
import { requireOwner } from '@/lib/guards'
import { mailReady } from '@/lib/mail'
import { ActionForm } from '@/components/ActionForm'
import { AccessPicker } from '@/components/AccessPicker'
import { Popup, Toolbar } from '@/components/Popup'
import { fmtTime } from '@/components/ui'
import { invitePersonAction, personMaintenanceAction, savePersonAction } from './actions'

export const metadata = { title: 'People' }
export const dynamic = 'force-dynamic'

const ROLE_TONE: Record<string, string> = { owner: 'info', operator: 'ok', viewer: '' }

export default async function PeoplePage() {
  const me = await requireOwner()
  const people = listAdmins()
  const clubs = listClubs()
  const sites = clubs.map((c) => ({ id: c.id, name: c.name, displayName: c.displayName, kind: c.kind }))
  const nameOf = new Map(clubs.map((c) => [c.id, c.displayName]))
  const projectList = listProjects()
  const projectName = new Map(projectList.map((p) => [p.id, p.displayName]))
  const projects = projectList.map((p) => ({ id: p.id, displayName: p.displayName, services: clubs.filter((c) => c.projectId === p.id).length }))
  const mailOn = mailReady()
  const expired = (iso: string | null) => !!iso && iso < new Date().toISOString()

  return (
    <>
      <div className="page-head">
        <div><h1>People</h1><p className="muted">Who can sign in to the deployer, and which sites and projects they can see. Changes apply straight away.</p></div>
        <Toolbar>
          <Popup label="Invite someone" short="Invite" title="Invite someone" icon="plus" primary panel sticky
            subtitle="They get a link that works once, for 72 hours, to pick a password and set up two-step sign-in.">
            <ActionForm action={invitePersonAction} submit="Invite" busy="Inviting…">
              <div className="grid cols-2">
                <div className="field"><label htmlFor="i-name">Name</label><input id="i-name" name="name" type="text" maxLength={80} /></div>
                <div className="field"><label htmlFor="i-email">Email</label><input id="i-email" name="email" type="email" required /></div>
              </div>
              <AccessPicker sites={sites} projects={projects} idPrefix="i" />
              <label className="small" style={{ fontWeight: 400 }}><input type="checkbox" name="sendEmail" defaultChecked={mailOn} disabled={!mailOn} /> Also email them the link{!mailOn && <> (set up outgoing email under <Link href="/admin/settings">Settings</Link> first)</>}</label>
            </ActionForm>
          </Popup>
        </Toolbar>
      </div>

      <div className="card">
        <div className="table-wrap"><table>
          <thead><tr><th>Person</th><th>Role</th><th>Can see</th><th>Two-step</th><th>Last signed in</th><th></th></tr></thead>
          <tbody>{people.map((p) => {
            const self = p.id === me.id
            return (
              <tr key={p.id}>
                <td>
                  <strong>{p.name || p.email}</strong>{self && <span className="badge" style={{ marginLeft: 6 }}>you</span>}
                  {p.name && <div className="muted small">{p.email}</div>}
                </td>
                <td>
                  <span className={`badge ${ROLE_TONE[p.role]}`}>{roleLabel(p.role)}</span>
                  {p.suspended && <span className="badge bad" style={{ marginLeft: 6 }}>suspended</span>}
                  {p.invited && <span className={`badge ${expired(p.inviteExpiresAt) ? 'bad' : 'warn'}`} style={{ marginLeft: 6 }}>{expired(p.inviteExpiresAt) ? 'invite expired' : 'invited'}</span>}
                </td>
                <td className="small wrap" style={{ maxWidth: 340 }}>{accessSummary(p, (id) => nameOf.get(id), (id) => projectName.get(id))}</td>
                <td>{p.invited ? <span className="muted">–</span> : p.totpConfirmed ? <span className="badge ok">On</span> : <span className="badge warn">Not set up yet</span>}</td>
                <td className="muted">{p.invited ? `Invited by ${p.invitedBy || 'an owner'}` : fmtTime(p.lastSignInAt) || 'Not yet'}</td>
                <td style={{ textAlign: 'right' }}>
                  <Popup label="Edit" title={p.name || p.email} subtitle={p.name ? p.email : undefined} icon="edit" panel sticky={p.invited}>
                    <ActionForm action={savePersonAction} submit="Save access" busy="Saving…">
                      <input type="hidden" name="id" value={p.id} />
                      <div className="field"><label htmlFor={`n-${p.id}`}>Name</label><input id={`n-${p.id}`} name="name" type="text" maxLength={80} defaultValue={p.name} /></div>
                      <AccessPicker sites={sites} projects={projects} role={p.role} allSites={p.allSites} siteIds={p.siteIds} projectIds={p.projectIds ?? []} idPrefix={`e${p.id}`} lockOwner={self} />
                    </ActionForm>

                    <h3 style={{ marginTop: 24 }}>Sign-in</h3>
                    {p.invited && (
                      <ActionForm action={personMaintenanceAction} submit="Make a new invite link" busy="Making…">
                        <input type="hidden" name="id" value={p.id} /><input type="hidden" name="kind" value="renew-invite" />
                        <p className="muted small">{expired(p.inviteExpiresAt) ? 'Their link has expired.' : `Their link works until ${fmtTime(p.inviteExpiresAt)}.`} A new link replaces it.</p>
                        <label className="small" style={{ fontWeight: 400 }}><input type="checkbox" name="sendEmail" defaultChecked={mailOn} disabled={!mailOn} /> Also email it</label>
                      </ActionForm>
                    )}
                    {!self && !p.invited && (
                      <ActionForm action={personMaintenanceAction} submit="Reset two-step sign-in" busy="Resetting…">
                        <input type="hidden" name="id" value={p.id} /><input type="hidden" name="kind" value="reset-two-step" />
                        <p className="muted small">For a lost phone: signs them out, and they scan a new QR code next time they sign in.</p>
                      </ActionForm>
                    )}
                    {!self && (
                      <ActionForm action={personMaintenanceAction} submit={p.suspended ? 'Let them sign in again' : 'Suspend'} busy="Saving…" danger={!p.suspended}>
                        <input type="hidden" name="id" value={p.id} /><input type="hidden" name="kind" value={p.suspended ? 'unsuspend' : 'suspend'} />
                        <p className="muted small">{p.suspended ? 'Suspended: they can’t sign in. Their access is kept for when you let them back.' : 'Signs them out at once and stops them signing in, keeping their access settings.'}</p>
                      </ActionForm>
                    )}
                    {!self && (
                      <div className="danger-zone">
                        <ActionForm action={personMaintenanceAction} submit="Remove" busy="Removing…" danger>
                          <input type="hidden" name="id" value={p.id} /><input type="hidden" name="kind" value="remove" />
                          <div className="field"><label htmlFor={`rm-${p.id}`}>Type <span className="mono">{p.email}</span> to remove them</label><input id={`rm-${p.id}`} name="confirm" type="text" autoComplete="off" /></div>
                        </ActionForm>
                      </div>
                    )}
                  </Popup>
                </td>
              </tr>
            )
          })}</tbody>
        </table></div>
      </div>
      <p className="help">Owners can do everything. Operators run their sites but can&apos;t create, remove or restore them, and can&apos;t see servers, settings, costs or people. Viewers only read status, monitoring, deploy output and logs. Secret values are blanked out of logs for everyone. Who did what is on <Link href="/admin/activity?tab=access">Activity &gt; Access log</Link>.</p>
    </>
  )
}
