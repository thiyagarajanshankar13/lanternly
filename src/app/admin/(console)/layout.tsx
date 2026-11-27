import { BrandLogo } from '@/components/BrandLogo'
import { SideNav, TabBar, TopCrumbs } from '@/components/SideNav'
import { Icon } from '@/components/Icon'
import { requireAdmin } from '@/lib/auth'
import { accessChip, canSeeSite, pagesFor } from '@/lib/access'
import { isFakeEngine } from '@/lib/engine'
import { isChecked, listWatched } from '@/lib/monitor'
import { getSettings } from '@/lib/settings'
import { enabledPlugins, pagesWithPlugins, pluginMenu, servicesLabel } from '@/plugins'
import { logoutAction } from '../auth-actions'

export const dynamic = 'force-dynamic'

export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const admin = await requireAdmin()
  // Only count sites this person can see (outside sites are for owners).
  const down = listWatched().filter((s) => (admin.role === 'owner' || canSeeSite(admin, s.clubId)) && isChecked(s) && s.status === 'down').length
  const plugins = enabledPlugins()
  const pages = pagesWithPlugins(pagesFor(admin), plugins, admin.role === 'owner')
  const extra = pluginMenu(plugins)
  const sitesLabel = servicesLabel(plugins)
  const practice = isFakeEngine()
  const initials = admin.email.slice(0, 2).toUpperCase()
  const brand = getSettings()
  const signOut = <form action={logoutAction}><button className="nav signout"><Icon name="logout" size={17} /><span>Sign out</span></button></form>
  return (
    <div className="shell">
      <nav className="side" aria-label="Deployer">
        <div className="brand"><BrandLogo width={30} height={26} /><span>{brand.brandName}{brand.brandTagline && <small>{brand.brandTagline}</small>}</span></div>
        <SideNav down={down} pages={pages} sitesLabel={sitesLabel} extra={extra} />
        <div className="spacer" />
        <div className="me">
          <span className="avatar" aria-hidden="true">{initials}</span>
          <span className="who">{admin.email}<small className="role-chip">{accessChip(admin)}</small></span>
        </div>
        {signOut}
      </nav>
      <div className="col">
        <header className="topbar">
          <BrandLogo className="topbar-logo" width={26} height={23} />
          <TopCrumbs sitesLabel={sitesLabel} extra={extra} />
          <div className="spacer" />
          {admin.role !== 'owner' && <span className="env-pill role" title="What you can see and do is set by an owner under People">{accessChip(admin)}</span>}
          {practice && <span className="env-pill" title="DEPLOYER_FAKE_ENGINE is on: nothing is really deployed">Practice mode</span>}
        </header>
        <main className="main">
          {children}
        </main>
      </div>
      <TabBar down={down} email={admin.email} signOut={signOut} pages={pages} sitesLabel={sitesLabel} extra={extra} />
    </div>
  )
}
