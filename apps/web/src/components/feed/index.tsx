import { ActivityList } from "./activity-list";
import { TypeFilter } from "./type-filter";

export function Feed() {
  return (
    <main className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden border-r bg-sidebar text-sidebar-foreground">
      <div className="flex items-center border-b">
        <TypeFilter />
      </div>
      <ActivityList />
    </main>
  );
}
