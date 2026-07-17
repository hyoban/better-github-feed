import { useEffect, useRef } from 'react'

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { formatRelativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'

import type { FollowUserData } from './follow-user-item'

type FollowUserCardProps = {
  follow: FollowUserData
  comfortable?: boolean
  isLast: boolean
  isActive: boolean
  isFocused: boolean
  onToggle: (actorKey: string, multiSelect: boolean) => void
  onFocus: () => void
}

export function FollowUserCard({
  follow,
  comfortable = false,
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
        'feed-row group flex w-full items-center border-l text-left transition-colors',
        comfortable ? 'min-h-12 gap-3 px-4 py-2.5' : 'gap-2.5 px-3 py-2',
        !isLast && 'border-b',
        isFocused || isActive
          ? 'border-l-foreground bg-muted'
          : 'border-l-transparent hover:bg-muted/50',
      )}
    >
      <Avatar className={comfortable ? 'size-7' : 'size-6'}>
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
        <AvatarFallback>{follow.login.slice(0, 2).toUpperCase()}</AvatarFallback>
      </Avatar>
      <p className="flex min-w-0 flex-1 items-center gap-1">
        <span className="min-w-0 flex-1 truncate">{follow.login}</span>
        <span className="shrink-0 text-muted-foreground">
          {formatRelativeTime(
            follow.latestEntryAt === null ? null : new Date(follow.latestEntryAt),
          )}
        </span>
      </p>
      {itemCount > 0 && (
        <span className="shrink-0 text-muted-foreground/70 tabular-nums">{itemCount}</span>
      )}
    </button>
  )
}
