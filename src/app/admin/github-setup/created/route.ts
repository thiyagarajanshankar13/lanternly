import { NextResponse } from 'next/server'
import { currentAdmin } from '@/lib/auth'
import { isOwner } from '@/lib/access'
import { audit } from '@/lib/audit'
import { deployerUrl } from '@/lib/deployerUrl'
import { convertManifest, installUrl, takeState } from '@/lib/apps/githubSetup'

export const dynamic = 'force-dynamic'

// GitHub sends the owner here after they confirm "Create GitHub App" (the
// manifest's redirect_url). The code becomes the new App's ID, key and webhook
// secret, kept as the pending app; then they go on to install it.
export async function GET(req: Request) {
  const admin = await currentAdmin()
  if (!admin) return NextResponse.redirect(`${deployerUrl()}/admin/login`)
  if (!isOwner(admin)) return new Response('Not found', { status: 404 })
  const q = new URL(req.url).searchParams
  const back = (msg: string) => NextResponse.redirect(`${deployerUrl()}/admin/settings/github?error=${encodeURIComponent(msg)}`)
  const asked = takeState(q.get('state') ?? '')
  if (!asked) return back('That link from GitHub has expired or was already used. Press Create GitHub app again.')
  try {
    const app = await convertManifest(q.get('code') ?? '', asked.owner, asked.buildRepo)
    await audit(admin, 'github', { detail: `Created GitHub App ${app.name} (${app.id}) on ${app.owner}` })
    return NextResponse.redirect(installUrl(app.slug))
  } catch (err) {
    return back((err as Error).message)
  }
}
