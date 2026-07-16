import NumberFlow from '@number-flow/react'
import { CircleAlertIcon, CloudIcon, CloudOffIcon } from 'lucide-react'

import { useLocalSyncStatus } from '@/hooks/use-local-feed'
import { cn } from '@/lib/utils'

import { presentSyncStatusSnapshot } from './sync-status-presentation'
import type { SyncStatusIcon } from './sync-status-presentation'

export function SyncStatusIndicator({ compact = false }: { compact?: boolean }) {
  const snapshot = useLocalSyncStatus()
  const status = presentSyncStatusSnapshot(snapshot)
  const presentation = {
    ...status,
    icon: getStatusIcon(status.icon, status.progress),
  }

  return (
    <div
      role="status"
      title={presentation.title}
      className={cn(
        'flex min-w-0 items-center gap-1.5 text-muted-foreground',
        compact ? 'size-9 justify-center' : 'px-1 py-0.5',
      )}
    >
      {presentation.icon}
      <span className={compact ? 'sr-only' : 'truncate'}>{presentation.label}</span>
    </div>
  )
}

function getStatusIcon(icon: SyncStatusIcon, progress?: number) {
  switch (icon) {
    case 'progress':
      return (
        <NumberFlow
          value={progress ?? 1}
          suffix="%"
          trend={1}
          isolate
          willChange
          transformTiming={{ duration: 180, easing: 'cubic-bezier(0.77, 0, 0.175, 1)' }}
          spinTiming={{ duration: 180, easing: 'cubic-bezier(0.77, 0, 0.175, 1)' }}
          opacityTiming={{ duration: 120, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' }}
          className="font-medium text-foreground tabular-nums"
          aria-hidden
        />
      )
    case 'cloud':
      return <CloudIcon className="size-5" />
    case 'cloud-off':
      return <CloudOffIcon className="size-5" />
    case 'cloud-off-warning':
      return <CloudOffIcon className="size-5 text-amber-600" />
    case 'attention':
      return <CircleAlertIcon className="size-5 text-destructive" />
  }
}
