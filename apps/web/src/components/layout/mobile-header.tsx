import { useFollowing } from '@/hooks/use-local-feed'
import { useActiveUsers } from '@/hooks/use-query-state'

import { SyncStatusIndicator } from '../sidebar/sync-status'
import { MobileSidebar } from './mobile-sidebar'
import { mobileHeaderTitle } from './mobile-header-title'

export function MobileHeader() {
  const [activeUsers] = useActiveUsers()
  const following = useFollowing({ sort: 'latest' })
  const follows = following.kind === 'ready' ? following.value.items : []
  const title = mobileHeaderTitle(activeUsers, follows)

  return (
    <header className="mobile-safe-header sticky top-0 z-30 flex shrink-0 items-center gap-2 border-b bg-background px-2 lg:hidden">
      <MobileSidebar />
      <span className="min-w-0 truncate font-medium">{title}</span>
      <div className="ml-auto">
        <SyncStatusIndicator compact />
      </div>
    </header>
  )
}
