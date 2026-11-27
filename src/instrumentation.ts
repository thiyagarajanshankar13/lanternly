// Runs once when the server starts: anything that was mid-flight when the
// deployer stopped is marked failed, queued operations carry on, the
// monitoring and backup timers start and the assistant's model is warmed up.
export async function register() {
  // Only in the Node.js server: the edge build must not see these imports
  // (ssh2 and SQLite are native modules), so they live in instrumentation-node.ts, imported only here.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startNode } = await import('./instrumentation-node')
    await startNode()
  }
}
