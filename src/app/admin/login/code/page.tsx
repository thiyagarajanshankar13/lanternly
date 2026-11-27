import { getSettings } from '@/lib/settings'
import { redirect } from 'next/navigation'
import QRCode from 'qrcode'
import { currentAdmin, enrolmentSecret, pendingAdmin } from '@/lib/auth'
import { totpUri } from '@/lib/totp'
import { CodeForm } from './CodeForm'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Two-step sign-in' }

export default async function CodePage() {
  if (await currentAdmin()) redirect('/admin')
  const admin = await pendingAdmin()
  if (!admin) redirect('/admin/login')

  // First sign-in: show the QR code to add to an authenticator app.
  let setup: { svg: string; secret: string } | null = null
  if (!admin.totpConfirmed) {
    const secret = enrolmentSecret(admin.id)
    const svg = await QRCode.toString(totpUri(secret, admin.email, getSettings().brandName), { type: 'svg', margin: 0, width: 180 })
    setup = { svg, secret }
  }

  return (
    <main className="center-page">
      <div className="card narrow">
        <h1>{setup ? 'Set up two-step sign-in' : 'Enter your code'}</h1>
        {setup ? (
          <>
            <p className="muted">Scan this with an authenticator app (Google Authenticator, 1Password, Authy), then enter the 6-digit code it shows.</p>
            <p style={{ textAlign: 'center' }}><span className="qr" dangerouslySetInnerHTML={{ __html: setup.svg }} /></p>
            <p className="small muted">Can&apos;t scan? Type this key into the app: <code>{setup.secret.match(/.{1,4}/g)?.join(' ')}</code></p>
          </>
        ) : (
          <p className="muted">Open your authenticator app and enter the code for {getSettings().brandName}.</p>
        )}
        <CodeForm label="6-digit code" />
        <p className="small" style={{ marginTop: 14, marginBottom: 0 }}><a href="/admin/login">Use a different account</a></p>
      </div>
    </main>
  )
}
