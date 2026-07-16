import { useCallback, useEffect, useMemo, useRef } from 'react'

import { ScrollArea } from '@/components/ui/scroll-area'
import { canonicalizeActorSelection } from '@/hooks/actor-selection'
import { userSelectionTransition } from '@/hooks/feed-selection-transition'
import { useFocusedPanel, useKeyboardNavigation } from '@/hooks/use-keyboard-navigation'
import { useFollowing } from '@/hooks/use-local-feed'
import { useActiveId, useActiveUsers, useSortBy } from '@/hooks/use-query-state'
import type { FollowingSummary } from '@/local-feed'

import { FollowUserItem } from './follow-user-item'

const NO_FOLLOWS: readonly FollowingSummary[] = []

type FollowListProps = {
  comfortable?: boolean
  onUserSelect?: () => void
}

export function FollowList({ comfortable, onUserSelect }: FollowListProps = {}) {
  const [sortBy] = useSortBy()
  const [activeUsers, setActiveUsers] = useActiveUsers()
  const [, setActiveId] = useActiveId()
  const [focusedPanel, setFocusedPanel] = useFocusedPanel()
  const snapshot = useFollowing({ sort: sortBy })
  const follows = snapshot.kind === 'ready' ? snapshot.value.items : NO_FOLLOWS
  const coverage = snapshot.kind === 'ready' ? snapshot.value.coverage : null

  const canonicalSelection = useMemo(() => {
    if (snapshot.kind !== 'ready') return activeUsers
    return canonicalizeActorSelection(activeUsers, follows, true)
  }, [activeUsers, follows, snapshot.kind])

  const updateUserSelection = useCallback(
    (next: readonly string[]) => {
      const transition = userSelectionTransition(canonicalSelection, next)
      if (!transition) return
      void Promise.all([setActiveUsers(transition.users), setActiveId(transition.id)])
    },
    [canonicalSelection, setActiveId, setActiveUsers],
  )

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
      if (newActorKey) updateUserSelection([newActorKey])
    },
    [canonicalSelection, focusedPanel, follows, updateUserSelection],
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
      updateUserSelection([follows[0].actorKey])
    }
    prevFocusedPanel.current = focusedPanel
  }, [canonicalSelection, focusedPanel, follows, updateUserSelection])

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
      updateUserSelection(
        selectedActorKeySet.has(actorKey)
          ? canonicalSelection.filter(item => item !== actorKey)
          : [...canonicalSelection, actorKey],
      )
      onUserSelect?.()
      return
    }

    updateUserSelection(
      canonicalSelection.length === 1 && canonicalSelection[0] === actorKey ? [] : [actorKey],
    )
    onUserSelect?.()
  }

  if (snapshot.kind === 'opening-local') {
    return <div className="min-h-0 flex-1" aria-hidden />
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
        <p className="text-muted-foreground">{message}</p>
      </div>
    )
  }

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div ref={listRef}>
        {follows.map((follow, index) => {
          const isActive = selectedActorKeySet.has(follow.actorKey)
          const isFocused = focusedPanel === 'sidebar' && canonicalSelection[0] === follow.actorKey
          return (
            <div key={follow.actorKey} data-actor-key={follow.actorKey}>
              <FollowUserItem
                follow={follow}
                comfortable={comfortable}
                isLast={index === follows.length - 1}
                isActive={isActive}
                isFocused={isFocused}
                onToggle={toggleUser}
                onFocus={() => {
                  setFocusedPanel('sidebar')
                  updateUserSelection([follow.actorKey])
                }}
              />
            </div>
          )
        })}
      </div>
    </ScrollArea>
  )
}
