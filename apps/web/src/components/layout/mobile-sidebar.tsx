import { MenuIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import UserMenu from "@/components/user-menu";

import { AddDeveloperDialog } from "../sidebar/add-developer-dialog";
import { FollowList } from "../sidebar/follow-list";
import { SortToggle } from "../sidebar/sort-toggle";

export function MobileSidebar() {
  return (
    <Sheet>
      <SheetTrigger render={<Button variant="ghost" size="icon" className="shrink-0" />}>
        <MenuIcon className="size-5" />
        <span className="sr-only">Toggle menu</span>
      </SheetTrigger>
      <SheetContent side="left" className="flex w-80 flex-col p-0" showCloseButton={false}>
        <div className="flex items-center border-b">
          <SortToggle />
        </div>
        <FollowList />
        <div className="flex justify-between gap-2 border-t p-2">
          <UserMenu />
          <AddDeveloperDialog />
        </div>
      </SheetContent>
    </Sheet>
  );
}
