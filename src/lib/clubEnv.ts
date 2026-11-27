// Addresses and the KEY=value settings format every service shares. What goes
// into a service's settings is up to its kind: apps in lib/apps/config.ts,
// Avrosphere sites in plugins/avrosphere/siteEnv.ts.

import type { PluginSecrets } from '@/plugins/secrets'

/**
 * A service's stored secrets: the app ones here, plus whatever a plugin's
 * service kind keeps (src/plugins/secrets.ts).
 */
export type ClubSecrets = {
  /** Apps only: secret settings (KEY → value), never shown again after saving. */
  appSecretEnv?: Record<string, string>
  /** Image apps only: sign-in for a private image (a Docker Hub access token, not the password). */
  registryUser?: string
  registryToken?: string
} & PluginSecrets

/** Main address first: the first custom domain when there is one, else the subdomain. */
export function clubDomains(club: { name: string; customDomains: string[]; appPublic?: boolean }, baseDomain: string): string[] {
  // An app with no web address has no domains at all.
  if (club.appPublic === false) return []
  const sub = `${club.name}.${baseDomain}`
  return [...club.customDomains, sub].filter((d, i, all) => all.indexOf(d) === i)
}

export function envToText(env: Record<string, string>): string {
  return Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n'
}
