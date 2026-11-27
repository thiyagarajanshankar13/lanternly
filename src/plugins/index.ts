// Plugins: the parts of the deployer that aren't needed by everyone who runs
// it. The core (projects, apps, Docker images, PostgreSQL, servers over SSH,
// addresses and HTTPS, backups, monitoring, people) is always there. A plugin
// adds a service type, pages and settings on top, and can be turned off on
// Settings › Plugins.
//
// Turning a plugin off hides what it adds; it never stops or removes what it
// already made. Its services keep running and are still backed up and
// monitored, but their pages answer "not found" until it's back on.
//
// Each plugin's own code lives in its folder here (src/plugins/<id>/).

import { getSettings, saveSettings } from '@/lib/settings'
import { INSTALLED_PLUGINS } from './installed'
import type { DeployerPlugin, PluginId } from './types'

export type { DeployerPlugin, PluginId } from './types'

/** Every plugin this copy of the deployer has, in the order Settings › Plugins lists them. */
export const PLUGINS: readonly DeployerPlugin[] = INSTALLED_PLUGINS

export const isPluginId = (v: unknown): v is PluginId => PLUGINS.some((p) => p.id === v)
export const getPlugin = (id: string): DeployerPlugin | undefined => PLUGINS.find((p) => p.id === id)

/** The plugins that are on, from Settings (unknown names are ignored). */
export function enabledPlugins(): Set<PluginId> {
  const on = new Set<PluginId>()
  for (const word of getSettings().plugins.split(/[\s,]+/)) if (isPluginId(word)) on.add(word)
  return on
}

export const pluginOn = (id: PluginId): boolean => enabledPlugins().has(id)

/** Turns one plugin on or off. Keeps the others as they are. */
export function setPluginOn(id: PluginId, on: boolean): void {
  const next = enabledPlugins()
  if (on) next.add(id)
  else next.delete(id)
  saveSettings({ plugins: PLUGINS.filter((p) => next.has(p.id)).map((p) => p.id).join(' ') })
}

/** The plugin a side-menu page belongs to, or undefined for a core page. */
export const pluginForPage = (href: string): DeployerPlugin | undefined => PLUGINS.find((p) => p.pages.includes(href))

/**
 * Side-menu pages that can be shown: the core pages given, and (for owners)
 * the pages of plugins that are on.
 */
export function pagesWithPlugins(pages: string[], on: Set<PluginId> = enabledPlugins(), owner = true): string[] {
  const core = pages.filter((href) => {
    const plugin = pluginForPage(href)
    return !plugin || on.has(plugin.id)
  })
  const fromPlugins = owner ? PLUGINS.filter((p) => on.has(p.id)).flatMap((p) => p.pages).filter((h) => !core.includes(h)) : []
  return [...core, ...fromPlugins]
}

/** The side-menu entries of the plugins that are on. */
export const pluginMenu = (on: Set<PluginId> = enabledPlugins()) => PLUGINS.filter((p) => on.has(p.id)).flatMap((p) => p.menu ?? [])

/** What the services list is called: a plugin's label while it's on ("Sites" for Avrosphere sites), else "Services". */
export const servicesLabel = (on: Set<PluginId> = enabledPlugins()): string =>
  PLUGINS.find((p) => on.has(p.id) && p.servicesLabel)?.servicesLabel ?? 'Services'

/** The plugin that adds a service kind, or undefined for a core kind (app, postgres, minio). */
export const pluginForKind = (kind: string): DeployerPlugin | undefined => PLUGINS.find((p) => p.serviceKinds?.includes(kind))

/** A service made by a plugin that is off (or not installed). Its pages and actions answer "not found". */
export function hiddenByPlugin(club: { kind: string }, on: Set<PluginId> = enabledPlugins()): boolean {
  if (club.kind === 'app' || club.kind === 'postgres' || club.kind === 'minio') return false
  const plugin = pluginForKind(club.kind)
  return !plugin || !on.has(plugin.id)
}

/** "New <kind>" links of the plugins that are on (New service picker, projects). */
export const newServiceLinks = (on: Set<PluginId> = enabledPlugins()) =>
  PLUGINS.filter((p) => on.has(p.id) && p.newService).map((p) => ({ plugin: p, ...p.newService! }))
