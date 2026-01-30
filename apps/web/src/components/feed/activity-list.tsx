import { useVirtualizer } from '@tanstack/react-virtual'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { useActivity } from '@/hooks/use-activity'
import { useFocusedPanel, useKeyboardNavigation } from '@/hooks/use-keyboard-navigation'
import { useActiveId, useActiveTypes, useActiveUsers } from '@/hooks/use-query-state'
import { useSubscriptionList } from '@/hooks/use-subscription-list'
import { authClient } from '@/lib/auth-client'

import { ActivitySummaryItem } from './activity-summary-item'

export function ActivityList() {
  const { data: session } = authClient.useSession()
  const [activeTypes] = useActiveTypes()
  const [activeUsers] = useActiveUsers()
  const [activeId, setActiveId] = useActiveId()
  const [focusedPanel, setFocusedPanel] = useFocusedPanel()

  const isAuthenticated = !!session
  const { follows } = useSubscriptionList(isAuthenticated)
  const { items, isLoading, isFetching, hasNextPage, isFetchingNextPage, fetchNextPage }
    = useActivity(isAuthenticated, activeUsers, activeTypes)

  const hasFollows = follows.length > 0

  // Create a map from login to githubUserId for avatar URLs
  const githubIdMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const follow of follows) {
      if (follow.githubUserId) {
        map.set(follow.githubUserLogin, follow.githubUserId)
      }
    }
    return map
  }, [follows])

  const emptyMessage
    = items.length === 0 && hasFollows
      ? 'No cached activity yet. Hit Refresh to fetch the latest feeds.'
      : 'No activity matches your filters yet.'
  const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null)
  const loadMoreTriggered = useRef(false)

  const scrollAreaRef = (node: HTMLDivElement | null) => {
    if (node) {
      const viewport = node.querySelector('[data-slot="scroll-area-viewport"]')
      if (viewport && viewport !== scrollElement) {
        setScrollElement(viewport as HTMLElement)
      }
    }
  }

  const virtualizer = useVirtualizer({
    count: items.length + (hasNextPage ? 1 : 0),
    getScrollElement: () => scrollElement,
    estimateSize: () => 80,
    overscan: 10,
    enabled: !!scrollElement,
  })

  // Keyboard navigation
  const handleNavigate = useCallback(
    (direction: 'up' | 'down') => {
      if (focusedPanel !== 'feed' || items.length === 0)
        return

      const ids = items.map(item => item.id)
      const currentIndex = activeId ? ids.indexOf(activeId) : -1

      let newIndex: number
      if (direction === 'up') {
        newIndex = currentIndex <= 0 ? 0 : currentIndex - 1
      }
      else {
        newIndex = currentIndex >= ids.length - 1 ? ids.length - 1 : currentIndex + 1
      }

      const newId = ids[newIndex]
      if (newId) {
        void setActiveId(newId)
        // Scroll to the item
        virtualizer.scrollToIndex(newIndex, { align: 'auto' })
      }
    },
    [focusedPanel, items, activeId, setActiveId, virtualizer],
  )

  useKeyboardNavigation(handleNavigate)

  // Auto-select first item when switching to this panel (only if no valid selection)
  const prevFocusedPanel = useRef(focusedPanel)
  useEffect(() => {
    if (prevFocusedPanel.current !== 'feed' && focusedPanel === 'feed') {
      // Switched to feed - only select first item if there's no valid selection
      const hasValidSelection = activeId && items.some(item => item.id === activeId)
      if (items.length > 0 && !hasValidSelection) {
        void setActiveId(items[0].id)
        virtualizer.scrollToIndex(0, { align: 'start' })
      }
    }
    prevFocusedPanel.current = focusedPanel
  }, [focusedPanel, items, activeId, setActiveId, virtualizer])

  if (isLoading) {
    return (
      <ScrollArea className="h-full min-h-0 flex-1">
        <div>
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="border-b border-l border-l-transparent px-4 py-3">
              <div className="flex gap-3">
                <Skeleton className="size-8 shrink-0 rounded-full" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-xs">
                    <Skeleton className="h-3.5 w-16" />
                    <span className="text-muted-foreground">&middot;</span>
                    <Skeleton className="h-3.5 w-10" />
                  </div>
                  <Skeleton className="mt-1.5 h-4 w-full" />
                  <Skeleton className="mt-1 h-4 w-2/3" />
                </div>
              </div>
            </div>
          ))}
        </div>
      </ScrollArea>
    )
  }

  if (items.length === 0) {
    return (
      <Empty className="border-solid">
        <EmptyHeader>
          <EmptyTitle>No activity</EmptyTitle>
          <EmptyDescription>{emptyMessage}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  // Reset load trigger when not fetching
  if (!isFetchingNextPage) {
    loadMoreTriggered.current = false
  }

  const showRefreshing = isFetching && !isLoading

  return (
    <div ref={scrollAreaRef} className="relative h-full min-h-0 flex-1">
      {showRefreshing && (
        <div className="absolute top-2 right-2 z-10 rounded-md bg-muted/80 p-1.5 backdrop-blur-sm">
          <Spinner className="size-3.5 text-muted-foreground" />
        </div>
      )}
      <ScrollArea className="h-full">
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: '100%',
            position: 'relative',
          }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const isLoaderRow = virtualRow.index >= items.length
            const item = items[virtualRow.index]

            // Trigger load more when loader row is rendered
            if (isLoaderRow && hasNextPage && !isFetchingNextPage && !loadMoreTriggered.current) {
              loadMoreTriggered.current = true
              fetchNextPage()
            }

            return (
              <div
                key={virtualRow.key}
                data-index={virtualRow.index}
                ref={virtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                {isLoaderRow || !item
                  ? (
                      isFetchingNextPage
                        ? (
                            <div className="border-b border-l border-l-transparent px-4 py-3">
                              <div className="flex gap-3">
                                <Skeleton className="size-8 shrink-0 rounded-full" />
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-2 text-xs">
                                    <Skeleton className="h-3.5 w-16" />
                                    <span className="text-muted-foreground">&middot;</span>
                                    <Skeleton className="h-3.5 w-10" />
                                  </div>
                                  <Skeleton className="mt-1.5 h-4 w-full" />
                                  <Skeleton className="mt-1 h-4 w-2/3" />
                                </div>
                              </div>
                            </div>
                          )
                        : null
                    )
                  : (
                      <ActivitySummaryItem
                        item={item}
                        githubId={githubIdMap.get(item.source)}
                        isActive={activeId === item.id}
                        isFocused={focusedPanel === 'feed' && activeId === item.id}
                        onClick={() => {
                          void setFocusedPanel('feed')
                          void setActiveId(item.id)
                        }}
                        onFocus={() => {
                          void setFocusedPanel('feed')
                          void setActiveId(item.id)
                        }}
                      />
                    )}
              </div>
            )
          })}
        </div>
      </ScrollArea>
    </div>
  )
}
