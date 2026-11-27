// Each installed plugin's parts of the core's pages (React components), by id.
// Kept apart from ./installed-hooks.ts so timers and tests never load page code.
// Same one-line-per-plugin layout as ./installed.ts.

import type { PluginParts } from './types'
import { awsParts } from './aws/parts' // plugin:aws

export const INSTALLED_PARTS: Record<string, PluginParts> = {
  aws: awsParts, // plugin:aws
}
