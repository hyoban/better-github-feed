import assert from 'node:assert/strict'

import { describe, it } from 'vite-plus/test'

import { runScheduledMaintenance } from './scheduled-maintenance'

describe('scheduled maintenance', () => {
  it('continues Atom refresh but skips cleanup when reconciliation fails', async () => {
    const calls: string[] = []
    const events: Array<Record<string, unknown>> = []

    await runScheduledMaintenance({
      syncFollowing: async () => {
        calls.push('following')
        return []
      },
      reconcileActivity: async () => {
        calls.push('reconcile')
        throw new Error('audit unavailable')
      },
      refreshActivity: async () => {
        calls.push('refresh')
        return []
      },
      cleanupActivity: async () => {
        calls.push('cleanup')
        return { deleted: 0 }
      },
      compactUserState: async () => {
        calls.push('compact-user-state')
        return { deletedChanges: 0, deletedReceipts: 0 }
      },
      log: event => events.push(event),
      logError: event => events.push(event),
    })

    assert.deepEqual(calls, ['following', 'reconcile', 'refresh', 'compact-user-state'])
    assert.deepEqual(
      events.map(event => event.message),
      [
        'following_sync_completed',
        'activity_reconciliation_failed',
        'refresh_completed',
        'cleanup_skipped',
        'user_state_compaction_completed',
      ],
    )
  })
})
