type ScheduledMaintenanceDependencies = {
  syncFollowing: () => Promise<unknown>
  reconcileActivity: () => Promise<{ audit: { ready: boolean } }>
  refreshActivity: () => Promise<unknown>
  cleanupActivity: () => Promise<unknown>
  compactUserState: () => Promise<unknown>
  log: (event: Record<string, unknown>) => void
  logError: (event: Record<string, unknown>) => void
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Unknown error'
}

export async function runScheduledMaintenance({
  syncFollowing,
  reconcileActivity,
  refreshActivity,
  cleanupActivity,
  compactUserState,
  log,
  logError,
}: ScheduledMaintenanceDependencies) {
  try {
    const results = await syncFollowing()
    log({ message: 'following_sync_completed', results })
  } catch (error) {
    logError({ message: 'following_sync_failed', error: errorMessage(error) })
  }

  let reconciliationSucceeded = false
  try {
    const results = await reconcileActivity()
    reconciliationSucceeded = results.audit.ready
    log({ message: 'activity_reconciliation_completed', results })
  } catch (error) {
    logError({ message: 'activity_reconciliation_failed', error: errorMessage(error) })
  }

  const refreshResults = await refreshActivity()
  log({ message: 'refresh_completed', results: refreshResults })

  if (reconciliationSucceeded) {
    const cleanupResults = await cleanupActivity()
    log({ message: 'cleanup_completed', results: cleanupResults })
  } else {
    log({ message: 'cleanup_skipped', reason: 'reconciliation-failed' })
  }

  try {
    const results = await compactUserState()
    log({ message: 'user_state_compaction_completed', results })
  } catch (error) {
    logError({ message: 'user_state_compaction_failed', error: errorMessage(error) })
  }
}
