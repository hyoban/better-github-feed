import { FollowList } from './follow-list'
import { SidebarFooter } from './footer'
import { SortToggle } from './sort-toggle'

export function Sidebar() {
  return (
    <aside className="hidden h-full min-h-0 w-64 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground lg:flex">
      <div className="flex items-center border-b">
        <SortToggle />
      </div>
      <FollowList />
      <SidebarFooter />
    </aside>
  )
}
