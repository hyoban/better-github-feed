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
        compact ? 'size-8 justify-center' : 'px-1 py-0.5',
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
        <span className="font-medium text-foreground tabular-nums" aria-hidden>
          {progress ?? 1}%
        </span>
      )
    case 'cloud':
      return <CloudIcon className="size-3.5" />
    case 'cloud-off':
      return <CloudOffIcon className="size-3.5" />
    case 'cloud-off-warning':
      return <CloudOffIcon className="size-3.5 text-amber-600" />
    case 'attention':
      return <CircleAlertIcon className="size-3.5 text-destructive" />
  }
}
