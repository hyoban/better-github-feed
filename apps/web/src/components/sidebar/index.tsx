import UserMenu from '@/components/user-menu'

import { FollowList } from './follow-list'
import { SortToggle } from './sort-toggle'
import { SyncStatusIndicator } from './sync-status'

export function Sidebar() {
  return (
    <aside className="hidden h-full min-h-0 w-64 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground lg:flex">
      <div className="flex items-center border-b">
        <SortToggle />
      </div>
      <FollowList />
      <div className="flex flex-col gap-1 border-t p-2">
        <SyncStatusIndicator />
        <UserMenu />
      </div>
    </aside>
  )
}
