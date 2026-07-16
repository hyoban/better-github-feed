import { memo, useEffect, useRef } from 'react'

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { formatRelativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { ActivitySummary } from '@/local-feed'

type ActivitySummaryItemProps = {
  item: ActivitySummary
  isActive: boolean
  isFocused: boolean
  showActor: boolean
  omitActorFromTitle: boolean
  onClick: () => void
  onFocus: () => void
}

export const ActivitySummaryItem = memo(
  ({
    item,
    isActive,
    isFocused,
    showActor,
    omitActorFromTitle,
    onClick,
    onFocus,
  }: ActivitySummaryItemProps) => {
    const buttonRef = useRef<HTMLButtonElement>(null)
    const isClickRef = useRef(false)
    const actorPrefix = `${item.actor} `
    const titleStartsWithActor =
      item.title.slice(0, actorPrefix.length).toLocaleLowerCase() ===
      actorPrefix.toLocaleLowerCase()
    const title =
      omitActorFromTitle && titleStartsWithActor ? item.title.slice(actorPrefix.length) : item.title

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
        onClick={() => {
          isClickRef.current = false
          onClick()
        }}
        onDoubleClick={() => {
          if (item.link) window.open(item.link, '_blank', 'noopener,noreferrer')
        }}
        onFocus={() => {
          // Only trigger onFocus for keyboard navigation (Tab), not for clicks
          if (!isClickRef.current) {
            onFocus()
          }
        }}
        className={cn(
          'w-full border-b border-l px-4 text-left',
          showActor ? 'feed-row-double' : 'feed-row',
          showActor ? 'py-3' : 'py-2',
          isFocused
            ? 'border-l-foreground/50 bg-foreground/9'
            : isActive
              ? 'border-l-foreground/40 bg-foreground/7'
              : 'border-l-transparent hover:bg-foreground/4',
        )}
        title={item.link ? 'Double-click to open on GitHub' : undefined}
      >
        {showActor ? (
          <div className="flex gap-3">
            <Avatar className="size-9 shrink-0">
              <AvatarImage
                src={
                  item.actorAvatarUrl ??
                  (item.actorGithubId
                    ? `https://avatars-githubusercontent-webp.webp.se/u/${item.actorGithubId}`
                    : `https://github.com/${item.actor}.png`)
                }
                alt={`${item.actor} avatar`}
                width={32}
                height={32}
              />
              <AvatarFallback>{item.actor.slice(0, 2).toUpperCase()}</AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-muted-foreground">
                <span className="font-medium text-foreground">{item.actor}</span>
                <span>{formatRelativeTime(new Date(item.publishedAt))}</span>
              </div>
              <p className="mt-1 truncate leading-snug text-foreground">{title}</p>
            </div>
          </div>
        ) : (
          <div className="flex min-w-0 items-center gap-3">
            <span className="min-w-0 flex-1 truncate text-foreground">{title}</span>
            <span className="shrink-0 text-muted-foreground">
              {formatRelativeTime(new Date(item.publishedAt))}
            </span>
          </div>
        )}
      </button>
    )
  },
)
