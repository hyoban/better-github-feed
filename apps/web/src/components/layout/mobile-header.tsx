import { RefreshActivity } from "../feed/refresh-activity";
import { MobileSidebar } from "./mobile-sidebar";

export function MobileHeader() {
  return (
    <header className="flex h-12 items-center justify-between border-b px-2 lg:hidden">
      <MobileSidebar />
      <span className="font-semibold">GitHub Feed</span>
      <RefreshActivity />
    </header>
  );
}
