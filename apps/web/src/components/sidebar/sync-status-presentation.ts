import type { LocalSyncStatus } from '@/local-feed'

export type SyncStatusIcon = 'progress' | 'cloud' | 'cloud-off' | 'cloud-off-warning' | 'attention'

type SyncStatusSnapshot =
  | { kind: 'opening-local' }
  | { kind: 'failed' }
  | { kind: 'ready'; value: LocalSyncStatus }

export function presentSyncStatusSnapshot(snapshot: SyncStatusSnapshot): {
  label: string
  title: string
  icon: SyncStatusIcon
  progress?: number
} {
  if (snapshot.kind === 'opening-local') {
    return {
      label: 'Local feed',
      title: 'Local feed status is initializing.',
      icon: 'cloud',
    }
  }
  if (snapshot.kind === 'failed') {
    return {
      label: 'Local sync status unavailable',
      title: 'Local sync status unavailable',
      icon: 'attention',
    }
  }

  return presentSyncStatus(snapshot.value)
}

export function presentSyncStatus(status: LocalSyncStatus): {
  label: string
  title: string
  icon: SyncStatusIcon
  progress?: number
} {
  switch (status.kind) {
    case 'working': {
      const copy = {
        control: ['Checking for updates…', 'Checking the cloud replica for updates.'],
        following: ['Syncing following…', 'Updating your complete GitHub Following snapshot.'],
        activity: ['Syncing activity…', 'Downloading all available Activity updates.'],
        'user-state': ['Syncing settings…', 'Synchronizing local filters and account state.'],
      } as const
      const [label, title] = copy[status.phase]
      const requestedProgress = status.progress ?? 1
      const progress = Number.isFinite(requestedProgress)
        ? Math.min(99, Math.max(1, Math.round(requestedProgress)))
        : 1
      return {
        label,
        title: `${title} ${progress}% complete.`,
        icon: 'progress',
        progress,
      }
    }
    case 'offline': {
      const label = 'Offline, local data ready'
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
