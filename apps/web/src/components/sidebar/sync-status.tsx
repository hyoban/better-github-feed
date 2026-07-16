import { CircleAlertIcon, CloudIcon, CloudOffIcon } from 'lucide-react'

import { Spinner } from '@/components/ui/spinner'
import { useLocalSyncStatus } from '@/hooks/use-local-feed'
import { cn } from '@/lib/utils'

import { presentSyncStatus } from './sync-status-presentation'
import type { SyncStatusIcon } from './sync-status-presentation'

export function SyncStatusIndicator({ compact = false }: { compact?: boolean }) {
  const snapshot = useLocalSyncStatus()
  const presentation = getPresentation(snapshot)

  return (
    <div
      role="status"
      title={presentation.title}
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
    return {
      label: 'Opening local data',
      title: 'Opening local data',
      icon: <Spinner className="size-3.5" />,
    }
  }
  if (snapshot.kind === 'failed') {
    return {
      label: 'Local sync status unavailable',
      title: 'Local sync status unavailable',
      icon: <CircleAlertIcon className="size-3.5 text-destructive" />,
    }
  }

  const presentation = presentSyncStatus(snapshot.value)
  return {
    ...presentation,
    icon: getStatusIcon(presentation.icon),
  }
}

function getStatusIcon(icon: SyncStatusIcon) {
  switch (icon) {
    case 'loading':
      return <Spinner className="size-3.5" />
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
