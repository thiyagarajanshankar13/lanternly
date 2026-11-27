import { redirect } from 'next/navigation'
import { adminCount } from '@/lib/auth'
import { SetupForm } from './SetupForm'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'First-time setup' }

export default function SetupPage() {
  if (adminCount() > 0) redirect('/admin/login')
  return (
    <main className="center-page">
      <div className="card narrow">
        <h1>First-time setup</h1>
        <p className="muted">Create the first admin for this deployer. You&apos;ll set up two-step sign-in next.</p>
        <SetupForm />
      </div>
    </main>
  )
}
