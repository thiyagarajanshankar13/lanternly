import { handlePush, type PushEvent } from '@/lib/apps/builds'
import { validSignature } from '@/lib/apps/github'
import { getSettings } from '@/lib/settings'

export const dynamic = 'force-dynamic'

// GitHub App webhook: a push to a branch an app follows builds and deploys it.
// Signed with the webhook secret from Settings; anything unsigned is refused.
export async function POST(req: Request) {
  const secret = getSettings().githubWebhookSecret
  if (!secret) return Response.json({ error: 'Not set up' }, { status: 404 })
  const body = await req.text()
  if (body.length > 5_000_000) return Response.json({ error: 'Too large' }, { status: 413 })
  if (!validSignature(body, req.headers.get('x-hub-signature-256'), secret)) return Response.json({ error: 'Bad signature' }, { status: 401 })
  const event = req.headers.get('x-github-event') ?? ''
  if (event === 'ping') return Response.json({ ok: true })
  if (event !== 'push') return Response.json({ ok: true, ignored: event })
  let push: PushEvent
  try { push = JSON.parse(body) as PushEvent } catch { return Response.json({ error: 'Bad JSON' }, { status: 400 }) }
  const started = await handlePush(push)
  return Response.json({ ok: true, deploying: started }, { status: 202 })
}
