import { useDefaultLayout } from 'react-resizable-panels'

import { DetailPanel } from '@/components/detail-panel'
import { ActivityList } from '@/components/feed/activity-list'
import { TypeFilter } from '@/components/feed/type-filter'
import { MobileDetailDrawer } from '@/components/layout/mobile-detail-drawer'
import { MobileHeader } from '@/components/layout/mobile-header'
import { Sidebar } from '@/components/sidebar'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { FocusedPanelProvider } from '@/hooks/focused-panel-provider'
import { useIsDesktop } from '@/hooks/use-mobile'

function FeedToolbar() {
  return (
    <div className="min-w-0 border-b">
      <TypeFilter />
    </div>
  )
}

function ActivityPane({ resizable = false }: { resizable?: boolean }) {
  return (
    <main
      className={`h-full min-h-0 bg-background/50 text-foreground md:overflow-hidden ${
        resizable ? '' : 'md:border-r'
      }`}
    >
      <ActivityList />
    </main>
  )
}

function DesktopFeedLayout() {
  const outerLayout = useDefaultLayout({
    id: 'desktop-feed-columns',
    panelIds: ['sidebar', 'workspace'],
    onlySaveAfterUserInteractions: true,
  })
  const innerLayout = useDefaultLayout({
    id: 'desktop-workspace-columns',
    panelIds: ['activity', 'detail'],
    onlySaveAfterUserInteractions: true,
  })

  return (
    <ResizablePanelGroup
      id="desktop-feed-columns"
      orientation="horizontal"
      className="min-h-0 flex-1"
      {...outerLayout}
    >
      <ResizablePanel
        id="sidebar"
        defaultSize={288}
        minSize={240}
        maxSize={400}
        groupResizeBehavior="preserve-pixel-size"
        className="min-w-0"
      >
        <Sidebar />
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel id="workspace" minSize={640} className="min-w-0">
        <div className="flex h-full min-h-0 min-w-0 flex-col">
          <FeedToolbar />
          <ResizablePanelGroup
            id="desktop-workspace-columns"
            orientation="horizontal"
            className="min-h-0 flex-1"
            {...innerLayout}
          >
            <ResizablePanel
              id="activity"
              defaultSize={480}
              minSize={320}
              maxSize={720}
              groupResizeBehavior="preserve-pixel-size"
              className="min-w-0"
            >
              <ActivityPane resizable />
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel id="detail" minSize={320} className="min-w-0">
              <DetailPanel />
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}

function CompactFeedLayout() {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <FeedToolbar />
      <div className="grid min-h-0 flex-1 md:grid-cols-[minmax(360px,420px)_1fr] md:overflow-hidden">
        <ActivityPane />
        <DetailPanel />
      </div>
    </div>
  )
}

export function Home() {
  const isDesktop = useIsDesktop()

  return (
    <FocusedPanelProvider>
      <div className="flex min-h-svh flex-col md:h-svh md:min-h-0 md:overflow-hidden">
        {/* Mobile Header */}
        <MobileHeader />

        {isDesktop ? <DesktopFeedLayout /> : <CompactFeedLayout />}

        {/* Mobile Detail Drawer */}
        <MobileDetailDrawer />
      </div>
    </FocusedPanelProvider>
  )
}
