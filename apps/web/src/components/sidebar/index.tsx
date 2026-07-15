import { RefreshAllUsersButton } from '@/components/feed/refresh-activity'
import UserMenu from '@/components/user-menu'

import { FollowList } from './follow-list'
import { SortToggle } from './sort-toggle'
import { SyncFollowingButton } from './sync-following-button'

export function Sidebar() {
  return (
    <aside className="hidden h-full min-h-0 w-64 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground lg:flex">
      <div className="flex items-center border-b">
        <SortToggle />
        <div className="pr-2">
          <RefreshAllUsersButton />
        </div>
      </div>
      <FollowList />
      <div className="flex gap-2 border-t p-2">
        <UserMenu />
        <SyncFollowingButton />
      </div>
    </aside>
  )
}
