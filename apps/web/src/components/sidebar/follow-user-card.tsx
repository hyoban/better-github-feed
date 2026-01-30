import { useEffect, useRef } from 'react'

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { formatRelativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'

import type { FollowUserData } from './follow-user-item'

type FollowUserCardProps = {
  follow: FollowUserData
  isActive: boolean
  isFocused: boolean
  onToggle: (login: string, multiSelect: boolean) => void
  onFocus: () => void
}

export function FollowUserCard({
  follow,
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
      onClick={(e) => {
        isClickRef.current = false
        onToggle(follow.githubUserLogin, e.metaKey || e.ctrlKey)
      }}
      onFocus={() => {
        // Only trigger onFocus for keyboard navigation (Tab), not for clicks
        if (!isClickRef.current) {
          onFocus()
        }
      }}
      aria-pressed={isActive}
      className={cn(
        'group flex w-full items-center gap-2 border-b border-l px-3 py-2 text-left transition-all',
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
            follow.githubUserId
              ? `https://avatars-githubusercontent-webp.webp.se/u/${follow.githubUserId}`
              : `https://github.com/${follow.githubUserLogin}.png`
          }
          alt={`${follow.githubUserLogin} avatar`}
          width={28}
          height={28}
        />
        <AvatarFallback className="text-xs">
          {follow.githubUserLogin.slice(0, 2).toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <p className="min-w-0 flex-1 truncate text-sm">
        {follow.githubUserLogin}
        <span className="text-muted-foreground">
          {' '}
          ·
          {formatRelativeTime(follow.latestEntryAt)}
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
