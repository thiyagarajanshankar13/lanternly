import { currentAdmin } from '@/lib/auth'
import { github, githubOwnerName } from '@/lib/apps/github'
import { repoError } from '@/lib/apps/config'

export const dynamic = 'force-dynamic'

/** The branches of one repo, for the New app form. */
export async function GET(req: Request) {
  const admin = await currentAdmin()
  if (!admin) return Response.json({ error: 'Not signed in' }, { status: 401 })
  if (admin.role !== 'owner') return Response.json({ error: 'Not found' }, { status: 404 })
  const repo = new URL(req.url).searchParams.get('repo') ?? ''
  const bad = repoError(repo, githubOwnerName())
  if (bad) return Response.json({ error: bad }, { status: 400 })
  try {
    return Response.json({ branches: await github().listBranches(repo) })
  } catch (err) {
    return Response.json({ error: (err as Error).message })
  }
}
