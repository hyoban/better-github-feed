import { DetailPanel } from '@/components/detail-panel'
import { ActivityList } from '@/components/feed/activity-list'
import { TypeFilter } from '@/components/feed/type-filter'
import { MobileDetailDrawer } from '@/components/layout/mobile-detail-drawer'
import { MobileHeader } from '@/components/layout/mobile-header'
import { Sidebar } from '@/components/sidebar'
import { FocusedPanelProvider } from '@/hooks/focused-panel-provider'

export function Home() {
  return (
    <FocusedPanelProvider>
      <div className="flex min-h-svh flex-col lg:h-full lg:min-h-0 lg:flex-row lg:overflow-hidden">
        {/* Mobile Header */}
        <MobileHeader />

        {/* Desktop Sidebar */}
        <Sidebar />

        {/* Main Content */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="min-w-0 border-b">
            <TypeFilter />
          </div>
          <div className="grid min-h-0 flex-1 lg:grid-cols-[420px_1fr] lg:overflow-hidden">
            <main className="bg-background/50 text-foreground lg:h-full lg:overflow-hidden lg:border-r">
              <ActivityList />
            </main>
            <DetailPanel />
          </div>
        </div>

        {/* Mobile Detail Drawer */}
        <MobileDetailDrawer />
      </div>
    </FocusedPanelProvider>
  )
}
