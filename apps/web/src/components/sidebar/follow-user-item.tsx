import { memo } from "react";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

import { FollowUserCard } from "./follow-user-card";
import { RemoveUserDialog } from "./remove-user-dialog";

export interface FollowUserData {
  id: string;
  githubUserLogin: string;
  githubUserId: string | null;
  itemCount: number | null;
  lastRefreshedAt: Date | string | null;
  latestEntryAt: Date | string | null;
}

interface FollowUserItemProps {
  follow: FollowUserData;
  isActive: boolean;
  isFocused: boolean;
  isRemovePending: boolean;
  onToggle: (login: string, multiSelect: boolean) => void;
  onFocus: () => void;
  onRefresh: (login: string) => void;
  onRemove: (id: string) => void;
}

export const FollowUserItem = memo(function FollowUserItem({
  follow,
  isActive,
  isFocused,
  isRemovePending,
  onToggle,
  onFocus,
  onRefresh,
  onRemove,
}: FollowUserItemProps) {
  return (
    <ContextMenu>
      <ContextMenuTrigger className="group/follow relative block">
        <FollowUserCard
          follow={follow}
          isActive={isActive}
          isFocused={isFocused}
          onToggle={onToggle}
          onFocus={onFocus}
        />
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          render={
            <a
              href={`https://github.com/${follow.githubUserLogin}`}
              target="_blank"
              rel="noreferrer"
            />
          }
        >
          Open GitHub
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onRefresh(follow.githubUserLogin)}>Refresh</ContextMenuItem>
        <RemoveUserDialog
          username={follow.githubUserLogin}
          disabled={isRemovePending}
          onConfirm={() => onRemove(follow.id)}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
});
