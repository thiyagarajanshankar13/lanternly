import type { ReactNode } from 'react'
import type { IconName } from '@/components/Icon'
import type { Runner, ServerRow } from '@/lib/engine'
import type { Club } from '@/lib/clubs'

/** A plugin's folder name under src/plugins, e.g. 'aws'. */
export type PluginId = string

/** One plugin, as Settings › Plugins and the side menu see it. */
export type DeployerPlugin = {
  id: PluginId
  name: string
  /** Who makes it, and whether it's published: "by Avrotech · private". */
  by: string
  /** One or two sentences on what it's for. */
  description: string
  /** Its icon on Settings › Plugins. */
  icon: IconName
  /** Short labels for what it adds, shown as chips: "Service type: Avrosphere site". */
  adds: string[]
  /** Side-menu pages it owns (owners only). They hide when it's off. */
  pages: string[]
  /** How those pages show in the side menu. */
  menu?: { href: string; label: string; icon: IconName; group: 'Operate' | 'Observe' | 'Infrastructure'; before?: string }[]
  /** Its own settings page, if it has one. */
  settingsHref?: string
  /** What happens when someone turns it off, shown before they do. */
  whenOff: string
  /** Service kinds it adds (the `kind` of their rows). They're hidden while it's off. */
  serviceKinds?: string[]
  /** What the services list is called while it's on ("Sites"); the first plugin that says wins. */
  servicesLabel?: string
  /** The services list's line under the heading while it's on. */
  servicesIntro?: string
  /** Where "New <kind>" goes in the New service picker and on a project; `?project=<id>` is added on a project. */
  newService?: { href: string; title: string; text: string; icon: IconName }
  /** Line under the heading of its settings page. */
  settingsIntro?: string
  /** The public front page (`/`) while it's on, in place of the redirect to the admin. */
  publicPage?: boolean
}

/**
 * What a plugin can add to the core's own pages and timers (src/plugins/server.ts
 * asks every plugin, so the core never imports a plugin's code itself). All optional.
 * Hooks of a plugin that is off are not called, apart from start(), whose timers
 * check for themselves (so work already under way, like deleting a server, can finish).
 */
export type PluginHooks = {
  /** Starts the plugin's timers when the deployer starts. */
  start?: () => void | Promise<void>
  /** Each project's estimated cost a month, as text ("A$12.40"), by project id. */
  projectCosts?: () => Map<number, string>
  /** Why a server can't be edited right now (it's being deleted), or null. */
  serverBusy?: (serverId: number) => string | null
  /** The newest version of the app this plugin runs ("1.5.0"), for Monitoring's "behind" badges; '' when unknown. */
  latestVersion?: () => Promise<string>
  /** Service kinds this plugin adds, by kind name. */
  serviceKinds?: Record<string, ServiceKindHooks>
}

type Part<P = object> = (props: P) => ReactNode | Promise<ReactNode>

/**
 * A server provider's parts of the Servers page (registered in src/plugins/parts.ts). Toolbar shows only while the
 * plugin is on; the rest also while it's off, so servers it made can still be
 * followed and deleted.
 */
export type ServersPageParts = {
  /** Buttons beside "Add existing server", like Create server. */
  Toolbar?: Part
  /** Above the list: work in progress, warnings. */
  Notices?: Part
  /** Something in progress, so the page doesn't say "no servers yet". */
  busy?: () => boolean
  /** A server this plugin made: it deletes it (the core's "delete the record" isn't offered). */
  owns?: (server: ServerRow) => boolean
  /** Added to the server's summary line. */
  Note?: Part<{ server: ServerRow }>
  /** In the server's Edit popup, at the bottom. */
  Danger?: Part<{ server: ServerRow }>
  /** Below the list. */
  Footer?: Part
}

/** A service row as the core's pages pass it to a plugin. */
type ServiceProps = { club: Club }

/** A plugin service kind's parts of the core's pages. */
export type ServiceKindParts = {
  /** Its whole page at /admin/clubs/<id>. */
  View: Part<{ club: Club; can: { operate: boolean; owner: boolean } }>
  /** The Sites list's Add-ons cell. */
  Addons?: Part<ServiceProps>
  /** The Sites list's Version cell. */
  Version?: Part<ServiceProps & { owner: boolean }>
  /** How a backup's image is shown ("1.5.0"); default the image name. */
  versionLabel?: (image: string) => string
  /** The kind's name for one service, as on project pages ("Avrosphere site"). */
  label?: string
}

/** A plugin's parts of the Sites (services) page, shown while it's on. */
export type SitesPageParts = {
  /** Buttons before New app (owners only). */
  Toolbar?: Part<{ clubs: Club[] }>
  /** Buttons after New app, like the main "New site" (owners only). */
  ToolbarEnd?: Part<{ clubs: Club[] }>
  /** Above the list (owners only). */
  Notices?: Part<{ clubs: Club[] }>
}

/** Everything a plugin adds to the core's pages (registered in src/plugins/installed-parts.ts). */
export type PluginParts = {
  servers?: ServersPageParts
  sites?: SitesPageParts
  serviceKinds?: Record<string, ServiceKindParts>
  /** Its settings page body (Settings › Plugins › <plugin>). */
  Settings?: Part
  /** The public front page (`/`), when the plugin has publicPage. */
  PublicPage?: { Page: Part; metadata?: import('next').Metadata }
}

/** What a service kind's step gets from the operations queue (src/lib/ops.ts). */
export type ServiceOpContext = {
  club: Club
  server: ServerRow
  /** The operation's payload (decrypted), as the action that queued it gave it. */
  payload: Record<string, unknown>
  createdBy: string
  /** The service's addresses, main one first, comma-separated. */
  domains: string
  /** Runs the server tool (clubctl) on the server. */
  run: Runner
  /** Adds to the operation's log. */
  out: (chunk: string) => void
}

/**
 * A plugin's own service kind (Avrosphere: 'avrosphere'). The queue runs pause,
 * resume, backups, restore, HTTPS and remove the same for every kind; runOp is
 * asked for everything else (create, configure, upgrade, and the kind's own
 * steps) and answers true/false, or null for a step it doesn't have. Asked
 * whether its plugin is on or off, so queued work finishes.
 */
export type ServiceKindHooks = {
  runOp: (op: string, ctx: ServiceOpContext) => Promise<boolean | null>
  /** The image an Upgrade press asks for (a picked version or a typed image), or '' for none. */
  upgradeImage?: (form: FormData) => string
}
