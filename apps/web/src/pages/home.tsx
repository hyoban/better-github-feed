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
      <div className="flex min-h-svh flex-col md:h-svh md:min-h-0 md:overflow-hidden lg:flex-row">
        {/* Mobile Header */}
        <MobileHeader />

        {/* Desktop Sidebar */}
        <Sidebar />

        {/* Main Content */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="min-w-0 border-b">
            <TypeFilter />
          </div>
          <div className="grid min-h-0 flex-1 md:grid-cols-[minmax(360px,420px)_1fr] md:overflow-hidden lg:grid-cols-[384px_1fr] xl:grid-cols-[480px_1fr]">
            <main className="bg-background/50 text-foreground md:h-full md:overflow-hidden md:border-r">
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
