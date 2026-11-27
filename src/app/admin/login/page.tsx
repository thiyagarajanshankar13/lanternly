import { BrandLogo } from '@/components/BrandLogo'
import { redirect } from 'next/navigation'
import { adminCount, currentAdmin } from '@/lib/auth'
import { getSettings } from '@/lib/settings'
import { LoginForm } from './LoginForm'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Sign in' }

export default async function LoginPage() {
  if (adminCount() === 0) redirect('/admin/setup')
  if (await currentAdmin()) redirect('/admin')
  const s = getSettings()
  return (
    <main className="center-page">
      <div className="card narrow">
        <BrandLogo width={52} height={46} style={{ marginBottom: 10 }} />
        <h1 style={{ textAlign: 'center' }}>{s.brandName}</h1>
        {s.brandTagline && <p className="muted small" style={{ textAlign: 'center', marginTop: -6 }}>{s.brandTagline}</p>}
        <p className="muted" style={{ textAlign: 'center' }}>Sign in to manage sites.</p>
        <LoginForm />
      </div>
    </main>
  )
}
