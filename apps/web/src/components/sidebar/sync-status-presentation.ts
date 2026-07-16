import type { LocalSyncStatus } from '@/local-feed'

export type SyncStatusIcon = 'working' | 'cloud' | 'cloud-off' | 'cloud-off-warning' | 'attention'

export function presentSyncStatus(status: LocalSyncStatus): {
  label: string
  title: string
  icon: SyncStatusIcon
} {
  switch (status.kind) {
    case 'working': {
      const label = `Syncing ${status.phase.replace('-', ' ')}`
      return { label, title: label, icon: 'working' }
    }
    case 'offline': {
      const label = status.hasUnmetDemand
        ? 'Offline · waiting to sync'
        : 'Offline · local data ready'
      return { label, title: label, icon: 'cloud-off' }
    }
    case 'degraded':
      return status.pendingUserOperations > 0
        ? {
            label: `${status.pendingUserOperations} local change${status.pendingUserOperations === 1 ? '' : 's'} waiting to sync`,
            title: 'Cloud sync is delayed. Local changes will sync automatically when available.',
            icon: 'cloud-off-warning',
          }
        : {
            label: 'Local feed ready',
            title: 'Local data is ready. Cloud sync will retry automatically.',
            icon: 'cloud',
          }
    case 'attention': {
      const label =
        status.issue === 'reauth-required'
          ? 'Sign in again to sync'
          : status.issue === 'account-mismatch'
            ? 'Sync paused for account safety'
            : 'Local storage is full'
      return { label, title: label, icon: 'attention' }
    }
    case 'quiet': {
      const label =
        status.pendingUserOperations > 0
          ? `${status.pendingUserOperations} local change${status.pendingUserOperations === 1 ? '' : 's'} queued`
          : 'Local feed ready'
      return { label, title: label, icon: 'cloud' }
    }
  }
}
