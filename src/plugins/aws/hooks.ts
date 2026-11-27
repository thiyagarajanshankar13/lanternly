import type { PluginHooks } from '../types'
import { currentEstimate } from './costs/estimate'
import { moneyFormatter, startCostScheduler } from './costs/service'
import { isBeingDeleted, startProvisionScheduler } from './provision/jobs'

// The AWS plugin's answers to the core (see PluginHooks). Its Servers page parts are in ./parts.ts.

export const awsHooks: PluginHooks = {
  start() {
    startCostScheduler()
    startProvisionScheduler()
  },
  projectCosts() {
    const est = currentEstimate()
    if (!est) return new Map()
    const fmt = moneyFormatter()
    return new Map(est.projects.map((p) => [p.id, fmt(p.total)]))
  },
  serverBusy: (serverId) => (isBeingDeleted(serverId) ? 'This server is being deleted.' : null),
}
