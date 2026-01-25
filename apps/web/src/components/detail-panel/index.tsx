import { useActivity } from "@/hooks/use-activity";
import { useActiveId, useActiveTypes, useActiveUsers } from "@/hooks/use-query-state";
import { authClient } from "@/lib/auth-client";

import { ActivityDetail } from "./activity-detail";

export function DetailPanel() {
  const { data: session } = authClient.useSession();
  const [activeId] = useActiveId();
  const [activeTypes] = useActiveTypes();
  const [activeUsers] = useActiveUsers();
  const { items } = useActivity(!!session, activeUsers, activeTypes);

  const selectedItem = items.find((item) => item.id === activeId);

  if (!selectedItem) {
    return (
      <aside className="hidden h-full min-h-0 flex-col items-center justify-center bg-background/50 p-8 text-center xl:flex">
        <p className="text-sm text-muted-foreground">Select an activity to view details</p>
      </aside>
    );
  }

  return (
    <aside className="hidden h-full min-h-0 flex-col overflow-hidden bg-background/50 xl:flex">
      <ActivityDetail item={selectedItem} />
    </aside>
  );
}
