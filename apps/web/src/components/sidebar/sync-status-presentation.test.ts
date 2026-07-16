import assert from 'node:assert/strict'

import { describe, it } from 'vite-plus/test'

import { presentSyncStatus, presentSyncStatusSnapshot } from './sync-status-presentation'

describe('sync status presentation', () => {
  it('does not use the remote-sync loading indicator while local status opens', () => {
    const presentation = presentSyncStatusSnapshot({ kind: 'opening-local' })

    assert.equal(presentation.icon, 'cloud')
  })

  it('shows the active automatic sync phase', () => {
    assert.deepEqual(
      presentSyncStatus({
        kind: 'working',
        phase: 'activity',
        progress: 42,
        pendingUserOperations: 0,
      }),
      {
        label: 'Syncing activity…',
        title: 'Downloading all available Activity updates. 42% complete.',
        icon: 'progress',
        progress: 42,
      },
    )
  })

  it('keeps working progress within the visible 1–99 range', () => {
    assert.equal(
      presentSyncStatus({
        kind: 'working',
        phase: 'control',
        progress: 100,
        pendingUserOperations: 0,
      }).progress,
      99,
    )
    assert.equal(
      presentSyncStatus({
        kind: 'working',
        phase: 'control',
        pendingUserOperations: 0,
      }).progress,
      1,
    )
  })

  it('keeps local readiness primary during an automatic cloud retry', () => {
    assert.deepEqual(
      presentSyncStatus({
        kind: 'degraded',
        issue: 'cloud-unavailable',
        retryAt: 2_000,
        pendingUserOperations: 0,
      }),
      {
        label: 'Local feed ready',
        title: 'Local data is ready. Cloud sync will retry automatically.',
        icon: 'cloud',
      },
    )
  })

  it('surfaces local changes that are waiting for cloud sync', () => {
    assert.deepEqual(
      presentSyncStatus({
        kind: 'degraded',
        issue: 'cloud-unavailable',
        retryAt: 2_000,
        pendingUserOperations: 2,
      }),
      {
        label: '2 local changes waiting to sync',
        title: 'Cloud sync is delayed. Local changes will sync automatically when available.',
        icon: 'cloud-off-warning',
      },
    )
  })
})
