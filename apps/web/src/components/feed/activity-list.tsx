import { useVirtualizer } from '@tanstack/react-virtual'
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'

import { shouldExtendActivityDemand } from '@/components/feed/automatic-demand'
import { ActivitySummaryItem } from '@/components/feed/activity-summary-item'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { toActorSelection, toTypeSelection } from '@/hooks/feed-view'
import { useFocusedPanel, useKeyboardNavigation } from '@/hooks/use-keyboard-navigation'
import { useVisibleFeed } from '@/hooks/use-local-feed'
import { useActiveId, useActiveTypes, useActiveUsers } from '@/hooks/use-query-state'
import type { ActivitySummary, FeedView } from '@/local-feed'

const INITIAL_DEMAND = 40
const DEMAND_STEP = 20
const NO_ACTIVITIES: readonly ActivitySummary[] = []

function activityFrontierKey(items: readonly ActivitySummary[]) {
  return JSON.stringify([items.length, items.at(-1)?.id ?? null])
}

export function ActivityList() {
  const [activeTypes] = useActiveTypes()
  const [activeUsers] = useActiveUsers()
  const [activeId, setActiveId] = useActiveId()
  const [focusedPanel, setFocusedPanel] = useFocusedPanel()
  const view = useMemo<FeedView>(
    () => ({
      actors: toActorSelection(activeUsers),
      types: toTypeSelection(activeTypes),
    }),
    [activeTypes, activeUsers],
  )
  const viewKey = JSON.stringify(view)
  const [demand, setDemand] = useState({
    viewKey,
    first: INITIAL_DEMAND,
    extendedFrontierKey: null as string | null,
  })
  const first = demand.viewKey === viewKey ? demand.first : INITIAL_DEMAND
  const extendedFrontierKey = demand.viewKey === viewKey ? demand.extendedFrontierKey : null
  const extendDemand = useCallback(
    (frontierKey: string) => {
      setDemand(current => ({
        viewKey,
        first: (current.viewKey === viewKey ? current.first : INITIAL_DEMAND) + DEMAND_STEP,
        extendedFrontierKey: frontierKey,
      }))
    },
    [viewKey],
  )
  const snapshot = useVisibleFeed({ view, first })
  const projectionState = useMemo(() => ({ snapshot, viewKey }), [snapshot, viewKey])
  const deferredProjectionState = useDeferredValue(projectionState)
  const renderedSnapshot =
    snapshot.kind === 'opening-local' &&
    deferredProjectionState.viewKey === viewKey &&
    deferredProjectionState.snapshot.kind === 'ready'
      ? deferredProjectionState.snapshot
      : snapshot

  const items = renderedSnapshot.kind === 'ready' ? renderedSnapshot.value.items : NO_ACTIVITIES
  const coverage = renderedSnapshot.kind === 'ready' ? renderedSnapshot.value.coverage : null
  const hasMoreHistory =
    coverage !== null &&
    (coverage.hasMoreLocal ||
      coverage.demand === 'insufficient' ||
      coverage.remoteWindow !== 'exhausted')
  const latestItems = snapshot.kind === 'ready' ? snapshot.value.items : NO_ACTIVITIES
  const latestCoverage = snapshot.kind === 'ready' ? snapshot.value.coverage : null
  const latestHasMoreHistory =
    latestCoverage !== null &&
    (latestCoverage.hasMoreLocal ||
      latestCoverage.demand === 'insufficient' ||
      latestCoverage.remoteWindow !== 'exhausted')
  const renderedFrontierKey = activityFrontierKey(items)
  const latestFrontierKey = activityFrontierKey(latestItems)
  const renderedFrontierWasExtended = extendedFrontierKey === renderedFrontierKey
  const latestFrontierWasExtended = extendedFrontierKey === latestFrontierKey
  const hasActiveFilters = activeUsers.length > 0 || activeTypes.length > 0

  const emptyMessage =
    snapshot.kind === 'failed'
      ? 'Local activity could not be read.'
      : snapshot.kind === 'ready' && snapshot.value.rejectedActorKeys.length > 0
        ? 'The selected people are not in your current GitHub Following snapshot.'
        : coverage?.bootstrap === 'never-synced'
          ? 'Your GitHub Following snapshot is syncing automatically.'
          : hasActiveFilters
            ? 'No locally available activity matches your filters yet.'
            : coverage?.remoteWindow === 'exhausted'
              ? 'No activity is available in your local or retained cloud history yet.'
              : 'Activity will appear here as the local feed catches up.'

  const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null)
  const scrollAreaRef = (node: HTMLDivElement | null) => {
    if (!node) return
    const viewport = node.querySelector('[data-slot="scroll-area-viewport"]')
    if (viewport && viewport !== scrollElement) {
      setScrollElement(viewport as HTMLElement)
    }
  }

  const virtualizer = useVirtualizer({
    count: items.length + (hasMoreHistory && !renderedFrontierWasExtended ? 1 : 0),
    getScrollElement: () => scrollElement,
    estimateSize: index => (index >= items.length ? 56 : 80),
    overscan: 10,
    enabled: !!scrollElement,
  })
  const virtualItems = virtualizer.getVirtualItems()
  const lastVirtualIndex = virtualItems.at(-1)?.index

  useEffect(() => {
    if (snapshot.kind !== 'ready') return
    if (
      !shouldExtendActivityDemand({
        alreadyExtendedAtFrontier: latestFrontierWasExtended,
        hasMoreHistory: latestHasMoreHistory,
        itemCount: latestItems.length,
        lastVirtualIndex,
      })
    )
      return

    const frame = requestAnimationFrame(() => extendDemand(latestFrontierKey))
    return () => cancelAnimationFrame(frame)
  }, [
    extendDemand,
    lastVirtualIndex,
    latestFrontierWasExtended,
    latestHasMoreHistory,
    latestFrontierKey,
    latestItems.length,
    snapshot.kind,
  ])

  const handleNavigate = useCallback(
    (direction: 'up' | 'down') => {
      if (focusedPanel !== 'feed' || items.length === 0) return

      const ids = items.map(item => item.id)
      const currentIndex = activeId ? ids.indexOf(activeId) : -1
      const newIndex =
        direction === 'up'
          ? currentIndex <= 0
            ? 0
            : currentIndex - 1
          : currentIndex >= ids.length - 1
            ? ids.length - 1
            : currentIndex + 1
      const newId = ids[newIndex]
      if (!newId) return

      void setActiveId(newId)
      virtualizer.scrollToIndex(newIndex, { align: 'auto' })
    },
    [activeId, focusedPanel, items, setActiveId, virtualizer],
  )

  useKeyboardNavigation(handleNavigate)

  const prevFocusedPanel = useRef(focusedPanel)
  useEffect(() => {
    if (prevFocusedPanel.current !== 'feed' && focusedPanel === 'feed') {
      const hasValidSelection = activeId && items.some(item => item.id === activeId)
      if (items.length > 0 && !hasValidSelection) {
        void setActiveId(items[0].id)
        virtualizer.scrollToIndex(0, { align: 'start' })
      }
    }
    prevFocusedPanel.current = focusedPanel
  }, [activeId, focusedPanel, items, setActiveId, virtualizer])

  if (renderedSnapshot.kind === 'opening-local') {
    return <ActivityListSkeleton />
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

  return (
    <div ref={scrollAreaRef} className="relative h-full min-h-0 flex-1">
      <ScrollArea className="h-full">
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: '100%',
            position: 'relative',
          }}
        >
          {virtualItems.map(virtualRow => {
            const isLoaderRow = virtualRow.index >= items.length
            const item = items[virtualRow.index]

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
                {isLoaderRow || !item ? (
                  <div className="flex justify-center border-b px-4 py-3 text-sm text-muted-foreground">
                    Loading older activity…
                  </div>
                ) : (
                  <ActivitySummaryItem
                    item={item}
                    isActive={activeId === item.id}
                    isFocused={focusedPanel === 'feed' && activeId === item.id}
                    onClick={() => {
                      setFocusedPanel('feed')
                      void setActiveId(item.id)
                    }}
                    onFocus={() => {
                      setFocusedPanel('feed')
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

function ActivityListSkeleton() {
  return (
    <ScrollArea className="h-full min-h-0 flex-1">
      <div>
        {Array.from({ length: 8 }).map((_, index) => (
          <div key={index} className="border-b border-l border-l-transparent px-4 py-3">
            <div className="flex gap-3">
              <Skeleton className="size-8 shrink-0 rounded-full" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-xs">
                  <Skeleton className="h-3.5 w-16" />
                  <Skeleton className="size-1 shrink-0 rounded-full" />
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
