import { CircleAlertIcon, CloudIcon, CloudOffIcon } from 'lucide-react'

import { Spinner } from '@/components/ui/spinner'
import { useLocalSyncStatus } from '@/hooks/use-local-feed'
import { cn } from '@/lib/utils'

export function SyncStatusIndicator({ compact = false }: { compact?: boolean }) {
  const snapshot = useLocalSyncStatus()
  const presentation = getPresentation(snapshot)

  return (
    <div
      role="status"
      title={presentation.label}
      className={cn(
        'flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground',
        compact ? 'size-8 justify-center' : 'px-1 py-0.5',
      )}
    >
      {presentation.icon}
      <span className={compact ? 'sr-only' : 'truncate'}>{presentation.label}</span>
    </div>
  )
}

function getPresentation(snapshot: ReturnType<typeof useLocalSyncStatus>) {
  if (snapshot.kind === 'opening-local') {
    return { label: 'Opening local data', icon: <Spinner className="size-3.5" /> }
  }
  if (snapshot.kind === 'failed') {
    return {
      label: 'Local sync status unavailable',
      icon: <CircleAlertIcon className="size-3.5 text-destructive" />,
    }
  }

  const status = snapshot.value
  switch (status.kind) {
    case 'working':
      return {
        label: `Syncing ${status.phase.replace('-', ' ')}`,
        icon: <Spinner className="size-3.5" />,
      }
    case 'offline':
      return {
        label: status.hasUnmetDemand ? 'Offline · waiting to sync' : 'Offline · local data ready',
        icon: <CloudOffIcon className="size-3.5" />,
      }
    case 'degraded':
      return {
        label: 'Cloud sync delayed',
        icon: <CloudOffIcon className="size-3.5 text-amber-600" />,
      }
    case 'attention':
      return {
        label:
          status.issue === 'reauth-required'
            ? 'Sign in again to sync'
            : status.issue === 'account-mismatch'
              ? 'Sync paused for account safety'
              : 'Local storage is full',
        icon: <CircleAlertIcon className="size-3.5 text-destructive" />,
      }
    case 'quiet':
      return {
        label:
          status.pendingUserOperations > 0
            ? `${status.pendingUserOperations} local change${status.pendingUserOperations === 1 ? '' : 's'} queued`
            : 'Local feed ready',
        icon: <CloudIcon className="size-3.5" />,
      }
  }
}
