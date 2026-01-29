import { DetailPanel } from "@/components/detail-panel";
import { ActivityList } from "@/components/feed/activity-list";
import { TypeFilter } from "@/components/feed/type-filter";
import { MobileDetailDrawer } from "@/components/layout/mobile-detail-drawer";
import { MobileHeader } from "@/components/layout/mobile-header";
import { Sidebar } from "@/components/sidebar";
import { FocusedPanelProvider } from "@/hooks/use-keyboard-navigation";

export default function Home() {
  return (
    <FocusedPanelProvider>
      <div className="flex h-full min-h-0 flex-col overflow-hidden md:flex-row">
        {/* Mobile Header */}
        <MobileHeader />

        {/* Desktop Sidebar */}
        <Sidebar />

        {/* Main Content */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="min-w-0 border-b">
            <TypeFilter />
          </div>
          <div className="grid min-h-0 flex-1 overflow-hidden xl:grid-cols-[420px_1fr]">
            <main className="h-full overflow-hidden bg-sidebar text-sidebar-foreground xl:border-r">
              <ActivityList />
            </main>
            <DetailPanel />
          </div>
        </div>

        {/* Mobile Detail Drawer */}
        <MobileDetailDrawer />
      </div>
    </FocusedPanelProvider>
  );
}
