import { DetailPanel } from "@/components/detail-panel";
import { ActivityList } from "@/components/feed/activity-list";
import { TypeFilter } from "@/components/feed/type-filter";
import { Sidebar } from "@/components/sidebar";
import { FocusedPanelProvider } from "@/hooks/use-keyboard-navigation";

export default function Home() {
  return (
    <FocusedPanelProvider>
      <div className="flex h-full min-h-0 gap-0 overflow-hidden">
        <Sidebar />
        <div className="w-full">
          <div className="border-b">
            <TypeFilter />
          </div>
          <div className="grid h-full overflow-hidden lg:grid-cols-[420px_1fr]">
            <main className="h-full overflow-hidden border-r bg-sidebar text-sidebar-foreground">
              <ActivityList />
            </main>
            <DetailPanel />
          </div>
        </div>
      </div>
    </FocusedPanelProvider>
  );
}
