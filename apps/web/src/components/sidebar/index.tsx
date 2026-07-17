import { FollowList } from './follow-list'
import { SidebarFooter } from './footer'
import { SortToggle } from './sort-toggle'

export function Sidebar() {
  return (
    <aside className="flex size-full min-h-0 flex-col bg-background/50 text-foreground">
      <div className="flex items-center border-b">
        <SortToggle />
      </div>
      <FollowList />
      <SidebarFooter />
    </aside>
  )
}
