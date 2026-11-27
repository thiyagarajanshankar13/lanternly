// The Node.js half of instrumentation.ts.
export async function startNode() {
  if (process.env.NEXT_PHASE === 'phase-production-build') return
  const { recoverInterrupted, kick } = await import('./lib/ops')
  try {
    recoverInterrupted()
    kick()
  } catch (err) {
    console.error('[deployer] could not resume the operation queue:', (err as Error).message)
  }
  try {
    const { startMonitor } = await import('./lib/monitor')
    startMonitor()
  } catch (err) {
    console.error('[deployer] could not start monitoring:', (err as Error).message)
  }
  try {
    const { startBackupScheduler } = await import('./lib/backups/scheduler')
    startBackupScheduler()
  } catch (err) {
    console.error('[deployer] could not start the backup schedule:', (err as Error).message)
  }
  try {
    const { startBuildPoller } = await import('./lib/apps/builds')
    startBuildPoller()
  } catch (err) {
    console.error('[deployer] could not start the app build watcher:', (err as Error).message)
  }
  try {
    const { startDatabaseWatch } = await import('./lib/postgres/service')
    startDatabaseWatch()
  } catch (err) {
    console.error('[deployer] could not start the database watch:', (err as Error).message)
  }
  // Each plugin's timers (AWS: costs and making servers; Avrosphere: the AI assistant).
  const { startPlugins } = await import('./plugins/server')
  await startPlugins()
}
