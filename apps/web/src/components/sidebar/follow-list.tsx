import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { canonicalizeActorSelection } from '@/hooks/actor-selection'
import { useFocusedPanel, useKeyboardNavigation } from '@/hooks/use-keyboard-navigation'
import { useFollowing } from '@/hooks/use-local-feed'
import { useActiveId, useActiveUsers, useSortBy } from '@/hooks/use-query-state'
import type { FollowingSummary } from '@/local-feed'

import { FollowUserItem } from './follow-user-item'

const INITIAL_DEMAND = 100
const DEMAND_STEP = 100
const LEGACY_URL_DEMAND = 1000
const NO_FOLLOWS: readonly FollowingSummary[] = []

function isStableActorKey(value: string) {
  return value.startsWith('github:') || value.startsWith('legacy-atom-login:')
}

export function FollowList() {
  const [sortBy] = useSortBy()
  const [activeUsers, setActiveUsers] = useActiveUsers()
  const [, setActiveId] = useActiveId()
  const [focusedPanel, setFocusedPanel] = useFocusedPanel()
  const [first, setFirst] = useState(() =>
    activeUsers.some(value => !isStableActorKey(value)) ? LEGACY_URL_DEMAND : INITIAL_DEMAND,
  )
  const snapshot = useFollowing({ sort: sortBy, first })
  const follows = snapshot.kind === 'ready' ? snapshot.value.items : NO_FOLLOWS
  const coverage = snapshot.kind === 'ready' ? snapshot.value.coverage : null
  const canLoadMore =
    coverage !== null &&
    (coverage.hasMoreLocal ||
      coverage.demand === 'insufficient' ||
      coverage.remoteWindow !== 'exhausted')

  const canonicalSelection = useMemo(() => {
    if (snapshot.kind !== 'ready') return activeUsers
    return canonicalizeActorSelection(activeUsers, follows, !canLoadMore)
  }, [activeUsers, canLoadMore, follows, snapshot.kind])

  useEffect(() => {
    if (snapshot.kind !== 'ready') return

    const isSame =
      canonicalSelection.length === activeUsers.length &&
      canonicalSelection.every((value, index) => value === activeUsers[index])
    if (isSame) return

    const removedSelection = canonicalSelection.length < activeUsers.length
    void setActiveUsers(canonicalSelection)
    if (removedSelection) void setActiveId(null)
  }, [activeUsers, canonicalSelection, setActiveId, setActiveUsers, snapshot.kind])

  const selectedActorKeySet = useMemo(() => new Set(canonicalSelection), [canonicalSelection])

  const handleNavigate = useCallback(
    (direction: 'up' | 'down') => {
      if (focusedPanel !== 'sidebar' || follows.length === 0) return

      const actorKeys = follows.map(follow => follow.actorKey)
      const currentActorKey = canonicalSelection[0]
      const currentIndex = currentActorKey ? actorKeys.indexOf(currentActorKey) : -1
      const newIndex =
        direction === 'up'
          ? currentIndex <= 0
            ? 0
            : currentIndex - 1
          : currentIndex >= actorKeys.length - 1
            ? actorKeys.length - 1
            : currentIndex + 1
      const newActorKey = actorKeys[newIndex]
      if (newActorKey) void setActiveUsers([newActorKey])
    },
    [canonicalSelection, focusedPanel, follows, setActiveUsers],
  )

  useKeyboardNavigation(handleNavigate)

  const prevFocusedPanel = useRef(focusedPanel)
  useEffect(() => {
    if (
      prevFocusedPanel.current !== 'sidebar' &&
      focusedPanel === 'sidebar' &&
      canonicalSelection.length === 0 &&
      follows[0]
    ) {
      void setActiveUsers([follows[0].actorKey])
    }
    prevFocusedPanel.current = focusedPanel
  }, [canonicalSelection, focusedPanel, follows, setActiveUsers])

  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const selectedActorKey = canonicalSelection[0]
    if (focusedPanel !== 'sidebar' || !selectedActorKey || !listRef.current) return

    const element = [...listRef.current.querySelectorAll<HTMLElement>('[data-actor-key]')].find(
      candidate => candidate.dataset.actorKey === selectedActorKey,
    )
    element?.scrollIntoView({ block: 'nearest' })
  }, [canonicalSelection, focusedPanel])

  const toggleUser = (actorKey: string, multiSelect: boolean) => {
    setFocusedPanel('sidebar')
    if (multiSelect) {
      void setActiveUsers(
        selectedActorKeySet.has(actorKey)
          ? canonicalSelection.filter(item => item !== actorKey)
          : [...canonicalSelection, actorKey],
      )
      return
    }

    void setActiveUsers(
      canonicalSelection.length === 1 && canonicalSelection[0] === actorKey ? [] : [actorKey],
    )
  }

  if (snapshot.kind === 'opening-local') {
    return <FollowListSkeleton />
  }

  if (snapshot.kind === 'failed' || follows.length === 0) {
    const message =
      snapshot.kind === 'failed'
        ? 'Local Following data could not be read.'
        : coverage?.bootstrap === 'never-synced'
          ? 'Your GitHub Following snapshot is syncing automatically.'
          : 'Your GitHub Following snapshot is empty.'
    return (
      <div className="flex min-h-0 flex-1 items-start px-4 pt-4">
        <p className="text-sm text-muted-foreground">{message}</p>
      </div>
    )
  }

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div ref={listRef}>
        {follows.map(follow => {
          const isActive = selectedActorKeySet.has(follow.actorKey)
          const isFocused = focusedPanel === 'sidebar' && canonicalSelection[0] === follow.actorKey
          return (
            <div key={follow.actorKey} data-actor-key={follow.actorKey}>
              <FollowUserItem
                follow={follow}
                isActive={isActive}
                isFocused={isFocused}
                onToggle={toggleUser}
                onFocus={() => {
                  setFocusedPanel('sidebar')
                  void setActiveUsers([follow.actorKey])
                }}
              />
            </div>
          )
        })}
        {canLoadMore && (
          <div className="flex justify-center border-b px-3 py-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setFirst(value => value + DEMAND_STEP)}
            >
              Load more
            </Button>
          </div>
        )}
      </div>
    </ScrollArea>
  )
}

function FollowListSkeleton() {
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div>
        {Array.from({ length: 8 }).map((_, index) => (
          <div key={index} className="flex items-center gap-2 border-b px-3 py-2">
            <div className="size-7 shrink-0 animate-pulse rounded-full bg-muted" />
            <Skeleton className="h-4 flex-1" />
          </div>
        ))}
      </div>
    </ScrollArea>
  )
}
