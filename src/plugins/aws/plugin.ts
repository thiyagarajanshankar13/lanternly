import type { DeployerPlugin } from '../types'

/**
 * Amazon Web Services: creating servers on Lightsail and the Costs page. Other
 * clouds don't need it: any server reachable over SSH can be added by hand.
 * Backups work with any S3-style bucket and stay in the core.
 */
export const awsPlugin: DeployerPlugin = {
  id: 'aws',
  name: 'Amazon Web Services',
  by: 'built in',
  icon: 'servers',
  description: 'Makes new servers on Lightsail and shows what AWS charges. Other clouds work without it: add any server you can reach over SSH.',
  adds: ['Servers: Create server', 'Page: Costs', 'Money in your currency'],
  pages: ['/admin/costs'],
  menu: [{ href: '/admin/costs', label: 'Costs', icon: 'dollar', group: 'Observe' }],
  settingsHref: '/admin/settings/plugins/aws',
  whenOff: 'Servers made on Lightsail keep running and stay on the Servers page. Create server and the Costs page go away until the plugin is back on.',
}
