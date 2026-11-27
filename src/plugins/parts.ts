// Plugin parts of core pages (React components), kept apart from ./server.ts
// so timers and tests never load page code.

import { enabledPlugins, PLUGINS } from '.'
import { INSTALLED_PARTS } from './installed-parts'
import type { PluginParts, ServersPageParts, ServiceKindParts, SitesPageParts } from './types'

/** One plugin's parts (empty when it has none). */
export const pluginParts = (id: string): PluginParts => INSTALLED_PARTS[id] ?? {}

/** The Servers page parts: toolbars of the plugins that are on, everything else from every plugin. */
export function serversPageParts(): { toolbars: ServersPageParts[]; all: ServersPageParts[] } {
  const on = enabledPlugins()
  const all = PLUGINS.map((p) => pluginParts(p.id).servers).filter((x): x is ServersPageParts => !!x)
  const toolbars = PLUGINS.filter((p) => on.has(p.id)).map((p) => pluginParts(p.id).servers).filter((x): x is ServersPageParts => !!x?.Toolbar)
  return { toolbars, all }
}

/** The Sites page parts of the plugins that are on. */
export function sitesPageParts(): SitesPageParts[] {
  const on = enabledPlugins()
  return PLUGINS.filter((p) => on.has(p.id)).map((p) => pluginParts(p.id).sites).filter((x): x is SitesPageParts => !!x)
}

/** A plugin service kind's parts (whether its plugin is on or not), or null. */
export function serviceKindParts(kind: string): ServiceKindParts | null {
  for (const p of PLUGINS) {
    const k = pluginParts(p.id).serviceKinds?.[kind]
    if (k) return k
  }
  return null
}

/** A plugin service kind's page, or null. */
export const serviceView = (kind: string) => serviceKindParts(kind)?.View ?? null

/** How a backup's image is shown for a service kind. */
export const versionLabelFor = (kind: string, image: string): string => serviceKindParts(kind)?.versionLabel?.(image) ?? image

/** The public front page of the first plugin that is on and has one, or null (the core redirects to the admin). */
export function publicPage() {
  const on = enabledPlugins()
  for (const p of PLUGINS) if (on.has(p.id) && p.publicPage) { const P = pluginParts(p.id).PublicPage; if (P) return P }
  return null
}
