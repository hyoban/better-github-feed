import { SyncStatusIndicator } from '../sidebar/sync-status'
import { MobileSidebar } from './mobile-sidebar'

export function MobileHeader() {
  return (
    <header className="sticky top-0 z-30 flex h-12 shrink-0 items-center gap-2 border-b bg-background px-2 lg:hidden">
      <MobileSidebar />
      <span className="font-medium">GitHub Feed</span>
      <div className="ml-auto">
        <SyncStatusIndicator compact />
      </div>
    </header>
  )
}
