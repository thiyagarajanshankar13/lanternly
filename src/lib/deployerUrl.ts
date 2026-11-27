/** The deployer's own web address (DEPLOYER_URL), without a trailing slash. Unset = local development. */
export function deployerUrl(): string {
  return (process.env.DEPLOYER_URL || 'http://localhost:3100').replace(/\/+$/, '')
}
