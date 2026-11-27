import { authorizeCallback, doneFrom, progressFrom, scriptFor } from '@/plugins/aws/provision/jobs'

// Called by a new server while it sets itself up (see plugins/aws/provision/jobs.ts):
// GET script, then POST progress lines and finally POST done with its host key.
// Each call needs the job's one-time code and must come from the server's own IP.

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string; step: string }> }

async function auth(req: Request, ctx: Ctx) {
  const { id, step } = await ctx.params
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim()
  const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim()
  return { step, result: authorizeCallback(Number(id), token, ip), token }
}

const refuse = (status: number) => new Response(status === 403 ? 'Not from this server\'s address\n' : 'Not found\n', { status })

export async function GET(req: Request, ctx: Ctx) {
  const { step, result, token } = await auth(req, ctx)
  if (step !== 'script') return refuse(404)
  if (!result.ok) return refuse(result.status)
  return new Response(scriptFor(result.job, token), { headers: { 'Content-Type': 'text/x-shellscript; charset=utf-8', 'Cache-Control': 'no-store' } })
}

export async function POST(req: Request, ctx: Ctx) {
  const { step, result } = await auth(req, ctx)
  if (step !== 'progress' && step !== 'done') return refuse(404)
  if (!result.ok) return refuse(result.status)
  const body = (await req.text()).slice(0, 20000)
  if (step === 'progress') progressFrom(result.job, body)
  else doneFrom(result.job, body)
  return new Response('ok\n')
}
