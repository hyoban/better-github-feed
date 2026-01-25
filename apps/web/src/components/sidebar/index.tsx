import UserMenu from "@/components/user-menu";

import { AddDeveloperDialog } from "./add-developer-dialog";
import { FollowList } from "./follow-list";
import { SortToggle } from "./sort-toggle";

export function Sidebar() {
  return (
    <aside className="flex h-full min-h-0 flex-col border-r bg-sidebar text-sidebar-foreground">
      <div className="flex items-center border-b">
        <SortToggle />
      </div>
      <FollowList />
      <div className="flex justify-between gap-2 border-t p-2">
        <UserMenu />
        <AddDeveloperDialog />
      </div>
    </aside>
  );
}
