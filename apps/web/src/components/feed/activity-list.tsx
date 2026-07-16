import { useVirtualizer, useWindowVirtualizer } from '@tanstack/react-virtual'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { selectStableProjectionSnapshot } from '@/components/local-feed/stable-projection-state'
import type { ReadyProjectionSnapshot } from '@/components/local-feed/stable-projection-state'
import { shouldExtendLocalActivityWindow } from '@/components/feed/automatic-window'
import { ActivitySummaryItem } from '@/components/feed/activity-summary-item'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { ScrollArea } from '@/components/ui/scroll-area'
import { toActorSelection, toTypeSelection } from '@/hooks/feed-view'
import { useFocusedPanel, useKeyboardNavigation } from '@/hooks/use-keyboard-navigation'
import { useVisibleFeed } from '@/hooks/use-local-feed'
import { useHasInlineDetail } from '@/hooks/use-mobile'
import { useActiveId, useActiveTypes, useActiveUsers } from '@/hooks/use-query-state'
import type { ActivitySummary, FeedView, VisibleFeedWindow } from '@/local-feed'

const INITIAL_WINDOW = 40
const WINDOW_STEP = 20
const NO_ACTIVITIES: readonly ActivitySummary[] = []

function activityFrontierKey(items: readonly ActivitySummary[]) {
  return JSON.stringify([items.length, items.at(-1)?.id ?? null])
}

export function ActivityList() {
  const hasInlineDetail = useHasInlineDetail()
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
  const [activityWindow, setActivityWindow] = useState({
    viewKey,
    first: INITIAL_WINDOW,
    extendedFrontierKey: null as string | null,
  })
  const first = activityWindow.viewKey === viewKey ? activityWindow.first : INITIAL_WINDOW
  const extendedFrontierKey =
    activityWindow.viewKey === viewKey ? activityWindow.extendedFrontierKey : null
  const extendWindow = useCallback(
    (frontierKey: string) => {
      setActivityWindow(current => ({
        viewKey,
        first: (current.viewKey === viewKey ? current.first : INITIAL_WINDOW) + WINDOW_STEP,
        extendedFrontierKey: frontierKey,
      }))
    },
    [viewKey],
  )
  const snapshot = useVisibleFeed({ view, first })
  const previousReadySnapshot = useRef<ReadyProjectionSnapshot<VisibleFeedWindow> | null>(null)
  const renderedSnapshot = selectStableProjectionSnapshot(snapshot, previousReadySnapshot.current)
  useEffect(() => {
    if (snapshot.kind === 'ready') previousReadySnapshot.current = snapshot
  }, [snapshot])

  const items = renderedSnapshot.kind === 'ready' ? renderedSnapshot.value.items : NO_ACTIVITIES
  const coverage = renderedSnapshot.kind === 'ready' ? renderedSnapshot.value.coverage : null
  const hasMoreLocal = coverage?.hasMoreLocal ?? false
  const latestItems = snapshot.kind === 'ready' ? snapshot.value.items : NO_ACTIVITIES
  const latestCoverage = snapshot.kind === 'ready' ? snapshot.value.coverage : null
  const latestHasMoreLocal = latestCoverage?.hasMoreLocal ?? false
  const renderedFrontierKey = activityFrontierKey(items)
  const latestFrontierKey = activityFrontierKey(latestItems)
  const renderedFrontierWasExtended = extendedFrontierKey === renderedFrontierKey
  const latestFrontierWasExtended = extendedFrontierKey === latestFrontierKey
  const hasActiveFilters = activeUsers.length > 0 || activeTypes.length > 0
  const hasSingleActor = activeUsers.length === 1
  const showActor = !hasInlineDetail || !hasSingleActor

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

  const virtualCount = items.length + (hasMoreLocal && !renderedFrontierWasExtended ? 1 : 0)
  const estimateVirtualRow = (index: number) => (index >= items.length ? 1 : showActor ? 80 : 48)
  const elementVirtualizer = useVirtualizer({
    count: virtualCount,
    getScrollElement: () => scrollElement,
    estimateSize: estimateVirtualRow,
    overscan: 10,
    enabled: hasInlineDetail && !!scrollElement,
  })
  const [windowScrollMargin, setWindowScrollMargin] = useState(0)
  const windowListRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return
    const nextMargin = node.getBoundingClientRect().top + window.scrollY
    setWindowScrollMargin(current => (current === nextMargin ? current : nextMargin))
  }, [])
  const windowVirtualizer = useWindowVirtualizer({
    count: virtualCount,
    estimateSize: estimateVirtualRow,
    overscan: 10,
    scrollMargin: windowScrollMargin,
    enabled: !hasInlineDetail,
  })
  const virtualizer = hasInlineDetail ? elementVirtualizer : windowVirtualizer
  const virtualItems = virtualizer.getVirtualItems()
  const lastVirtualIndex = virtualItems.at(-1)?.index

  useEffect(() => {
    if (snapshot.kind !== 'ready') return
    if (
      !shouldExtendLocalActivityWindow({
        alreadyExtendedAtFrontier: latestFrontierWasExtended,
        hasMoreLocal: latestHasMoreLocal,
        itemCount: latestItems.length,
        lastVirtualIndex,
      })
    )
      return

    const frame = requestAnimationFrame(() => extendWindow(latestFrontierKey))
    return () => cancelAnimationFrame(frame)
  }, [
    extendWindow,
    lastVirtualIndex,
    latestFrontierWasExtended,
    latestHasMoreLocal,
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
    return <div className="h-full min-h-0 flex-1" />
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

  const virtualContent = (
    <div
      style={{
        height: `${virtualizer.getTotalSize()}px`,
        width: '100%',
        position: 'relative',
      }}
    >
      {virtualItems.map(virtualRow => {
        const isWindowSentinel = virtualRow.index >= items.length
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
              transform: `translateY(${virtualRow.start - (hasInlineDetail ? 0 : windowScrollMargin)}px)`,
            }}
          >
            {isWindowSentinel || !item ? (
              <div className="h-px" aria-hidden />
            ) : (
              <ActivitySummaryItem
                item={item}
                isActive={activeId === item.id}
                isFocused={focusedPanel === 'feed' && activeId === item.id}
                showActor={showActor}
                omitActorFromTitle={hasSingleActor}
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
  )

  if (!hasInlineDetail) {
    return (
      <div ref={windowListRef} className="relative min-h-0 flex-1">
        {virtualContent}
      </div>
    )
  }

  return (
    <div ref={scrollAreaRef} className="relative h-full min-h-0 flex-1">
      <ScrollArea className="h-full">{virtualContent}</ScrollArea>
    </div>
  )
}
