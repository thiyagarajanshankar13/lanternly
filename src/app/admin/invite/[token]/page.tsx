import { getSettings } from '@/lib/settings'
import { findInvite } from '@/lib/auth'
import { roleLabel } from '@/lib/access'
import { InviteForm } from './InviteForm'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Join the deployer', robots: { index: false } }

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const person = findInvite(token)
  return (
    <main className="center-page">
      <div className="card narrow">
        {person ? (
          <>
            <h1>Welcome{person.name ? `, ${person.name.split(' ')[0]}` : ''}</h1>
            <p className="muted">You&apos;ve been invited to {getSettings().brandName} as <strong>{roleLabel(person.role)}</strong> ({person.email}). Pick a password, then set up two-step sign-in with an authenticator app.</p>
            <InviteForm token={token} email={person.email} />
          </>
        ) : (
          <>
            <h1>This link doesn&apos;t work</h1>
            <p className="muted" style={{ marginBottom: 0 }}>Invite links work once and for 72 hours. Ask the person who invited you for a new one. If you already picked a password, <a href="/admin/login">sign in</a>.</p>
          </>
        )}
      </div>
    </main>
  )
}
