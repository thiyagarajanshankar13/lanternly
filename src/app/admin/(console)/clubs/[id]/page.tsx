import { canOperateSite, isOwner } from '@/lib/access'
import { requireSite } from '@/lib/guards'
import { serviceView } from '@/plugins/parts'
import { AppView } from './AppView'
import { DatabaseView } from './DatabaseView'

export const metadata = { title: 'Site' }

export default async function ClubPage({ params }: { params: Promise<{ id: string }> }) {
  const { admin, club } = await requireSite(Number((await params).id), 'view')
  const can = { operate: canOperateSite(admin, club.id), owner: isOwner(admin) }
  if (club.kind === 'app') return <AppView club={club} can={can} />
  if (club.kind === 'postgres') return <DatabaseView club={club} can={can} />
  // Any other kind is a plugin's: it draws the page.
  const View = serviceView(club.kind)
  if (!View) return <div className="card"><h1>{club.displayName}</h1><p className="muted">This is a {club.kind} service, and the plugin that runs that kind isn&apos;t installed on this deployer.</p></div>
  return <View club={club} can={can} />
}
