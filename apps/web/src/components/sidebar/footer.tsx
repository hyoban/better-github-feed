import UserMenu from '@/components/user-menu'

import { SyncStatusIndicator } from './sync-status'

export function SidebarFooter() {
  return (
    <div className="flex items-center gap-0.5 border-t p-1.5">
      <SyncStatusIndicator compact />
      <UserMenu />
    </div>
  )
}
