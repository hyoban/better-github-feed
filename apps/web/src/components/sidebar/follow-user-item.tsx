import { memo } from 'react'

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'

import { FollowUserCard } from './follow-user-card'

export type FollowUserData = {
  id: string
  githubUserLogin: string
  githubUserId: string | null
  itemCount: number | null
  lastRefreshedAt: Date | string | null
  latestEntryAt: Date | string | null
}

type FollowUserItemProps = {
  follow: FollowUserData
  isActive: boolean
  isFocused: boolean
  onToggle: (login: string, multiSelect: boolean) => void
  onFocus: () => void
  onRefresh: (login: string) => void
}

export const FollowUserItem = memo(({
  follow,
  isActive,
  isFocused,
  onToggle,
  onFocus,
  onRefresh,
}: FollowUserItemProps) => {
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
          render={(
            <a
              href={`https://github.com/${follow.githubUserLogin}`}
              target="_blank"
              rel="noreferrer"
            />
          )}
        >
          Open GitHub
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onRefresh(follow.githubUserLogin)}>Refresh</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
})
