// The core's one door into plugin code. Pages, actions and the start-up code
// call these; each asks the plugins that are on (see PluginHooks in ./types).
// Server-side only: plugin hooks reach the database and the network.

import { enabledPlugins, PLUGINS } from '.'
import { INSTALLED_HOOKS } from './installed-hooks'
import type { PluginHooks, ServiceKindHooks } from './types'

const HOOKS: Record<string, PluginHooks> = INSTALLED_HOOKS
const hooksOf = (id: string): PluginHooks => HOOKS[id] ?? {}

const hooksOn = (): PluginHooks[] => {
  const on = enabledPlugins()
  return PLUGINS.filter((p) => on.has(p.id)).map((p) => hooksOf(p.id))
}

/** Starts every plugin's timers (on or off: each timer checks whether its plugin is on). */
export async function startPlugins(): Promise<void> {
  for (const p of PLUGINS) {
    try { await hooksOf(p.id).start?.() }
    catch (err) { console.error(`[deployer] could not start the ${p.name} plugin:`, (err as Error).message) }
  }
}

/** Each project's estimated monthly cost as text, from the first plugin that knows prices; empty when none is on. */
export function projectCosts(): Map<number, string> {
  for (const h of hooksOn()) if (h.projectCosts) return h.projectCosts()
  return new Map()
}

/** Why a server can't be changed right now, or null. */
export function serverBusy(serverId: number): string | null {
  for (const h of Object.values(HOOKS)) {
    const why = h.serverBusy?.(serverId)
    if (why) return why
  }
  return null
}


/** The steps of a service kind a plugin adds (whether that plugin is on or not), or null for a core kind. */
export function serviceKind(kind: string): ServiceKindHooks | null {
  for (const h of Object.values(HOOKS)) {
    const k = h.serviceKinds?.[kind]
    if (k) return k
  }
  return null
}

/** The newest app version a plugin that is on knows of ("1.5.0"), else ''. */
export async function latestAppVersion(): Promise<string> {
  for (const h of hooksOn()) {
    if (!h.latestVersion) continue
    try { const v = await h.latestVersion(); if (v) return v } catch { /* no version from this one */ }
  }
  return ''
}
