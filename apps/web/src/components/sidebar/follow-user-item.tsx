import { memo } from 'react'

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import type { FollowingSummary } from '@/local-feed'

import { FollowUserCard } from './follow-user-card'

export type FollowUserData = FollowingSummary

type FollowUserItemProps = {
  follow: FollowUserData
  comfortable?: boolean
  isLast: boolean
  isActive: boolean
  isFocused: boolean
  onToggle: (actorKey: string, multiSelect: boolean) => void
  onFocus: () => void
}

export const FollowUserItem = memo(
  ({
    follow,
    comfortable,
    isLast,
    isActive,
    isFocused,
    onToggle,
    onFocus,
  }: FollowUserItemProps) => {
    return (
      <ContextMenu>
        <ContextMenuTrigger className="group/follow relative block">
          <FollowUserCard
            follow={follow}
            comfortable={comfortable}
            isLast={isLast}
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
                href={`https://github.com/${follow.login}`}
                target="_blank"
                rel="noreferrer"
                aria-label={`Open ${follow.login} on GitHub`}
              />
            }
          >
            Open GitHub
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    )
  },
)
