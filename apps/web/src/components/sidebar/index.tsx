import { FollowList } from './follow-list'
import { SidebarFooter } from './footer'
import { SortToggle } from './sort-toggle'

export function Sidebar() {
  return (
    <aside className="hidden h-full min-h-0 w-72 shrink-0 flex-col border-r bg-background/50 text-foreground lg:flex">
      <div className="flex items-center border-b">
        <SortToggle />
      </div>
      <FollowList />
      <SidebarFooter />
    </aside>
  )
}
