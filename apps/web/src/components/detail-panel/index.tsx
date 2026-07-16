import { useActiveId } from '@/hooks/use-query-state'

import { ActivityDetailLoader } from './activity-detail-loader'

export function DetailPanel() {
  const [activeId] = useActiveId()

  if (!activeId) {
    return (
      <aside className="hidden h-full min-h-0 flex-col items-center justify-center bg-background/50 p-8 text-center lg:flex">
        <p className="text-muted-foreground">Select an activity to view details</p>
      </aside>
    )
  }

  return (
    <aside className="hidden h-full min-h-0 flex-col overflow-hidden bg-background/50 lg:flex">
      <ActivityDetailLoader id={activeId} />
    </aside>
  )
}
