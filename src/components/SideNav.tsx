'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Icon, type IconName } from './Icon'

/** A side-menu page. Plugins add theirs (see menu in src/plugins/types.ts); `before` puts one ahead of a core page in its group. */
export type NavItem = { href: string; label: string; icon: IconName; group: string; also?: string[]; before?: string }
type Item = NavItem

const ITEMS: Item[] = [
  { href: '/admin', label: 'Sites', icon: 'sites', group: 'Operate', also: ['/admin/clubs', '/admin/apps'] },
  { href: '/admin/projects', label: 'Projects', icon: 'project', group: 'Operate' },
  { href: '/admin/monitor', label: 'Monitoring', icon: 'monitor', group: 'Operate' },
  { href: '/admin/backups', label: 'Backups', icon: 'backups', group: 'Operate' },
  { href: '/admin/activity', label: 'Activity', icon: 'activity', group: 'Observe' },
  { href: '/admin/people', label: 'People', icon: 'people', group: 'Infrastructure' },
  { href: '/admin/servers', label: 'Servers', icon: 'servers', group: 'Infrastructure' },
  { href: '/admin/settings', label: 'Settings', icon: 'settings', group: 'Infrastructure' },
  { href: '/admin/account', label: 'Your account', icon: 'key', group: 'You' },
]
/** The core's pages with the plugins' pages put in their groups. */
function withPluginItems(extra: Item[]): Item[] {
  const all = [...ITEMS]
  for (const item of extra) {
    const at = item.before ? all.findIndex((i) => i.href === item.before) : -1
    const lastOfGroup = all.map((i) => i.group).lastIndexOf(item.group)
    all.splice(at >= 0 ? at : lastOfGroup >= 0 ? lastOfGroup + 1 : all.length, 0, item)
  }
  return all
}
/** The menu for one person: only the pages their role can open (see lib/access.ts). */
const itemsFor = (pages?: string[], sitesLabel = 'Sites', extra: Item[] = []) =>
  (pages ? withPluginItems(extra).filter((i) => pages.includes(i.href)) : withPluginItems(extra)).map((i) => (i.href === '/admin' ? { ...i, label: sitesLabel } : i))
/** The four on the phone tab bar; the rest go under "More". */
const TABS = ['/admin', '/admin/monitor', '/admin/backups', '/admin/activity']

const under = (path: string, base: string) => path === base || path.startsWith(`${base}/`)
const isActive = (item: Item, path: string) =>
  item.href === '/admin' ? path === '/admin' || (item.also ?? []).some((a) => under(path, a)) : under(path, item.href)

function Badge({ item, down }: { item: Item; down: number }) {
  return item.href === '/admin/monitor' && down > 0 ? <em className="nav-count" title={`${down} down`}>{down}</em> : null
}

/** The console's side menu, grouped, with the page you're on marked. */
/** sitesLabel: a plugin's name for the list ("Sites" with Avrosphere sites), else "Services" (see src/plugins). */
export function SideNav({ down = 0, pages, sitesLabel, extra }: { down?: number; pages?: string[]; sitesLabel?: string; extra?: Item[] }) {
  const path = usePathname() || ''
  let group = ''
  return (
    <>
      {itemsFor(pages, sitesLabel, extra).map((item) => {
        const active = isActive(item, path)
        const head = item.group !== group ? <div className="nav-group">{(group = item.group)}</div> : null
        return (
          <div key={item.href} className="nav-wrap">
            {head}
            <Link className={active ? 'nav active' : 'nav'} aria-current={active ? 'page' : undefined} href={item.href}>
              <Icon name={item.icon} size={17} /><span>{item.label}</span><Badge item={item} down={down} />
            </Link>
          </div>
        )
      })}
    </>
  )
}

/** Where you are, for the top bar: "Sites", or "Sites / Site" on a page under it. */
export function TopCrumbs({ sitesLabel, extra }: { sitesLabel?: string; extra?: Item[] }) {
  const path = usePathname() || ''
  const item = itemsFor(undefined, sitesLabel, extra).find((i) => isActive(i, path))
  if (!item) return null
  const sub = path === item.href ? null
    : path === '/admin/clubs/new' ? 'New site'
    : under(path, '/admin/settings/plugins') ? 'Plugins'
    : item.href === '/admin' ? (sitesLabel === 'Services' ? 'Service' : 'Site')
    : item.href === '/admin/monitor' ? 'Site'
    : null
  return (
    <div className="crumbs">
      {sub ? <><Link href={item.href}>{item.label}</Link><i aria-hidden="true">/</i><b>{sub}</b></> : <b>{item.label}</b>}
    </div>
  )
}

/** Phone only: a tab bar along the bottom, with the rest of the menu under More. */
export function TabBar({ down = 0, email, signOut, pages, sitesLabel, extra }: { down?: number; email: string; signOut: React.ReactNode; pages?: string[]; sitesLabel?: string; extra?: Item[] }) {
  const path = usePathname() || ''
  const items = itemsFor(pages, sitesLabel, extra)
  const rest = items.filter((i) => !TABS.includes(i.href))
  const moreActive = rest.some((i) => isActive(i, path))
  return (
    <nav className="tabbar" aria-label="Deployer">
      {items.filter((i) => TABS.includes(i.href)).map((item) => {
        const active = isActive(item, path)
        return (
          <Link key={item.href} href={item.href} className={active ? 'tab active' : 'tab'} aria-current={active ? 'page' : undefined}>
            <span className="tab-icon"><Icon name={item.icon} size={21} /><Badge item={item} down={down} /></span>{item.label}
          </Link>
        )
      })}
      <details className={moreActive ? 'tab-more active' : 'tab-more'} key={path}>
        <summary className="tab"><span className="tab-icon"><Icon name="more" size={21} /></span>More</summary>
        <div className="tab-sheet">
          {rest.map((item) => (
            <Link key={item.href} href={item.href} className={isActive(item, path) ? 'nav active' : 'nav'}><Icon name={item.icon} size={17} /><span>{item.label}</span></Link>
          ))}
          <div className="who">{email}</div>
          {signOut}
        </div>
      </details>
    </nav>
  )
}
