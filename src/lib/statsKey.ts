import { derivedSecret } from './crypto'

/**
 * The key a deployer-run site answers /api/health/stats with. Derived from
 * the deployer's secret and the site's name, so nothing is stored and the
 * site gets the same key every time its settings are applied.
 */
export const clubStatsKey = (clubName: string) => derivedSecret(`stats:${clubName}`)
