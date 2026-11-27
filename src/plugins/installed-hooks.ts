// Each installed plugin's server-side hooks (timers, steps, numbers), by id.
// Same one-line-per-plugin layout as ./installed.ts.

import type { PluginHooks } from './types'
import { awsHooks } from './aws/hooks' // plugin:aws

export const INSTALLED_HOOKS: Record<string, PluginHooks> = {
  aws: awsHooks, // plugin:aws
}
