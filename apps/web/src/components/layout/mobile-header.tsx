import { SyncStatusIndicator } from '../sidebar/sync-status'
import { MobileSidebar } from './mobile-sidebar'

export function MobileHeader() {
  return (
    <header className="flex h-12 items-center gap-2 border-b px-2 lg:hidden">
      <MobileSidebar />
      <span className="font-medium">GitHub Feed</span>
      <div className="ml-auto">
        <SyncStatusIndicator compact />
      </div>
    </header>
  )
}
