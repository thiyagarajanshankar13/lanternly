import Link from 'next/link'
import { requireAdmin } from '@/lib/auth'
import { accessSummary, roleLabel } from '@/lib/access'
import { listClubs } from '@/lib/clubs'
import { ActionForm } from '@/components/ActionForm'
import { fmtTime } from '@/components/ui'
import { changeOwnPasswordAction } from '../people/actions'

export const metadata = { title: 'Your account' }

export default async function AccountPage() {
  const me = await requireAdmin()
  const clubs = listClubs()
  const nameOf = new Map(clubs.map((c) => [c.id, c.displayName]))
  const mine = me.role === 'owner' || me.allSites ? [] : clubs.filter((c) => me.siteIds.includes(c.id))
  return (
    <>
      <div className="page-head"><div><h1>Your account</h1><p className="muted">{me.name ? `${me.name} · ` : ''}{me.email}</p></div></div>
      <div className="grid cols-2">
        <div className="card" style={{ marginBottom: 0 }}>
          <h2>What you can do</h2>
          <p><span className="badge info">{roleLabel(me.role)}</span></p>
          <p className="muted">{accessSummary(me, (id) => nameOf.get(id))}</p>
          {mine.length > 0 && <ul className="small">{mine.map((c) => <li key={c.id}><Link href={`/admin/clubs/${c.id}`}>{c.displayName}</Link></li>)}</ul>}
          {me.role !== 'owner' && <p className="help">An owner sets this under People. Ask them if you need more.</p>}
          <dl className="facts"><dt>Last signed in</dt><dd>{fmtTime(me.lastSignInAt) || '–'}</dd></dl>
        </div>
        <div className="card" style={{ marginBottom: 0 }}>
          <h2>Change your password</h2>
          <ActionForm action={changeOwnPasswordAction} submit="Change password" busy="Saving…">
            <input type="email" name="email" value={me.email} autoComplete="username" readOnly hidden />
            <div className="field"><label htmlFor="pw1">New password</label><input id="pw1" name="password" type="password" autoComplete="new-password" minLength={12} required /><div className="help">At least 12 characters. You&apos;ll be signed out everywhere and sign in again with it.</div></div>
            <div className="field"><label htmlFor="pw2">New password again</label><input id="pw2" name="password2" type="password" autoComplete="new-password" minLength={12} required /></div>
          </ActionForm>
        </div>
      </div>
    </>
  )
}
