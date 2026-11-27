import { NextResponse } from 'next/server'
import { currentAdmin } from '@/lib/auth'
import { isOwner } from '@/lib/access'
import { audit } from '@/lib/audit'
import { deployerUrl } from '@/lib/deployerUrl'
import { finishInstall, pendingApp } from '@/lib/apps/githubSetup'

export const dynamic = 'force-dynamic'

// GitHub sends the owner here after installing the App or changing its repos
// (the manifest's setup_url). A pending app becomes the one the deployer uses
// once its installation is there; then the build repo gets its secrets.
export async function GET() {
  const admin = await currentAdmin()
  if (!admin) return NextResponse.redirect(`${deployerUrl()}/admin/login`)
  if (!isOwner(admin)) return new Response('Not found', { status: 404 })
  const pending = pendingApp()
  const page = `${deployerUrl()}/admin/settings/github`
  try {
    const r = await finishInstall()
    if (r.switched) await audit(admin, 'github', { detail: `Switched to GitHub App ${pending?.name ?? ''} (${pending?.id ?? ''})` })
    if (r.secrets === 'saved') await audit(admin, 'github', { detail: 'Saved the build secrets in the build repo' })
    const q = new URLSearchParams({ done: r.switched ? 'switched' : 'updated' })
    if (r.secrets === 'failed' && r.detail) q.set('error', r.detail)
    return NextResponse.redirect(`${page}?${q}`)
  } catch (err) {
    return NextResponse.redirect(`${page}?error=${encodeURIComponent(`The new GitHub App isn't installed on ${pending?.owner ?? 'the organisation'} yet. ${(err as Error).message}`)}`)
  }
}
