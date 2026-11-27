// The plugins this copy of the deployer has. One import and one entry per
// plugin, each tagged with its id, so a copy without a plugin is this file
// with that plugin's two lines removed (see scripts/export-core.mjs).

import type { DeployerPlugin } from './types'
import { awsPlugin } from './aws/plugin' // plugin:aws

/** In the order Settings › Plugins lists them. */
export const INSTALLED_PLUGINS: DeployerPlugin[] = [
  awsPlugin, // plugin:aws
]
