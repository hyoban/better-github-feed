import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import { useActivity } from "@/hooks/use-activity";
import { useIsDesktop } from "@/hooks/use-mobile";
import { useActiveId, useActiveTypes, useActiveUsers } from "@/hooks/use-query-state";
import { authClient } from "@/lib/auth-client";

import { ActivityDetail } from "../detail-panel/activity-detail";

export function MobileDetailDrawer() {
  const { data: session } = authClient.useSession();
  const [activeId, setActiveId] = useActiveId();
  const [activeTypes] = useActiveTypes();
  const [activeUsers] = useActiveUsers();
  const { items } = useActivity(!!session, activeUsers, activeTypes);
  const isDesktop = useIsDesktop();

  const selectedItem = items.find((item) => item.id === activeId);

  // Don't show drawer on desktop (xl+), DetailPanel handles it there
  if (isDesktop) {
    return null;
  }

  return (
    <Drawer
      open={!!selectedItem}
      onOpenChange={(open) => {
        if (!open) {
          void setActiveId(null);
        }
      }}
    >
      <DrawerContent className="max-h-[85vh]">
        <DrawerTitle className="sr-only">Activity Details</DrawerTitle>
        {selectedItem && <ActivityDetail item={selectedItem} />}
      </DrawerContent>
    </Drawer>
  );
}
