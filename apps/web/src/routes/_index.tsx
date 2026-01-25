import { DetailPanel } from "@/components/detail-panel";
import { Feed } from "@/components/feed";
import { Sidebar } from "@/components/sidebar";
import { FocusedPanelProvider } from "@/hooks/use-keyboard-navigation";

export default function Home() {
  return (
    <FocusedPanelProvider>
      <div className="grid h-full min-h-0 gap-0 overflow-hidden lg:grid-cols-[260px_1fr] xl:grid-cols-[280px_420px_1fr]">
        <Sidebar />
        <Feed />
        <DetailPanel />
      </div>
    </FocusedPanelProvider>
  );
}
