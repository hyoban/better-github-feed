import { Drawer, DrawerContent, DrawerTitle } from '@/components/ui/drawer'
import { useHasInlineDetail } from '@/hooks/use-mobile'
import { useActiveId } from '@/hooks/use-query-state'

import { ActivityDetailLoader } from '../detail-panel/activity-detail-loader'

export function MobileDetailDrawer() {
  const [activeId, setActiveId] = useActiveId()
  const hasInlineDetail = useHasInlineDetail()

  if (hasInlineDetail) {
    return null
  }

  return (
    <Drawer
      open={!!activeId}
      onOpenChange={open => {
        if (!open) {
          void setActiveId(null)
        }
      }}
    >
      <DrawerContent className="max-h-[85vh]">
        <DrawerTitle className="sr-only">Activity Details</DrawerTitle>
        {activeId && <ActivityDetailLoader id={activeId} />}
      </DrawerContent>
    </Drawer>
  )
}
