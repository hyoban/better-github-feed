import { useEffect, useRef } from 'react'

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { formatRelativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'

import type { FollowUserData } from './follow-user-item'

type FollowUserCardProps = {
  follow: FollowUserData
  isLast: boolean
  isActive: boolean
  isFocused: boolean
  onToggle: (actorKey: string, multiSelect: boolean) => void
  onFocus: () => void
}

export function FollowUserCard({
  follow,
  isLast,
  isActive,
  isFocused,
  onToggle,
  onFocus,
}: FollowUserCardProps) {
  const itemCount = follow.itemCount ?? 0
  const buttonRef = useRef<HTMLButtonElement>(null)
  const isClickRef = useRef(false)

  useEffect(() => {
    if (isFocused) {
      buttonRef.current?.focus()
    }
  }, [isFocused])

  return (
    <button
      ref={buttonRef}
      type="button"
      onPointerDown={() => {
        isClickRef.current = true
      }}
      onClick={e => {
        isClickRef.current = false
        onToggle(follow.actorKey, e.metaKey || e.ctrlKey)
      }}
      onFocus={() => {
        // Only trigger onFocus for keyboard navigation (Tab), not for clicks
        if (!isClickRef.current) {
          onFocus()
        }
      }}
      aria-pressed={isActive}
      className={cn(
        'group flex w-full items-center gap-2 border-l px-3 py-2 text-left transition-all',
        !isLast && 'border-b',
        isFocused
          ? 'border-l-primary bg-sidebar-accent'
          : isActive
            ? 'border-l-primary/80 bg-sidebar-accent/80'
            : 'border-l-transparent hover:bg-sidebar-accent/50',
      )}
    >
      <Avatar className="size-5">
        <AvatarImage
          src={
            follow.avatarUrl ??
            (follow.githubId
              ? `https://avatars-githubusercontent-webp.webp.se/u/${follow.githubId}`
              : `https://github.com/${follow.login}.png`)
          }
          alt={`${follow.login} avatar`}
          width={28}
          height={28}
        />
        <AvatarFallback className="text-xs">
          {follow.login.slice(0, 2).toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <p className="min-w-0 flex-1 truncate text-sm">
        {follow.login}
        <span className="text-muted-foreground">
          {' '}
          ·
          {formatRelativeTime(
            follow.latestEntryAt === null ? null : new Date(follow.latestEntryAt),
          )}
        </span>
      </p>
      {itemCount > 0 && (
        <Badge variant="secondary" className="h-5 shrink-0 px-1.5 text-[10px] font-semibold">
          {itemCount}
        </Badge>
      )}
    </button>
  )
}
