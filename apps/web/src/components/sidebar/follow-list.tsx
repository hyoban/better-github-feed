import { useCallback, useEffect, useMemo, useRef } from 'react'

import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { useFocusedPanel, useKeyboardNavigation } from '@/hooks/use-keyboard-navigation'
import { useActiveUsers, useSortBy } from '@/hooks/use-query-state'
import { useRefreshFeed, useRemoveSubscription } from '@/hooks/use-subscription-actions'
import { useSubscriptionList } from '@/hooks/use-subscription-list'
import { authClient } from '@/lib/auth-client'

import { FollowUserItem } from './follow-user-item'

export function FollowList() {
  const { data: session } = authClient.useSession()
  const { follows, isLoading } = useSubscriptionList(!!session)
  const { removeUser, isPending: isRemovePending } = useRemoveSubscription()
  const { refreshSingleFeed } = useRefreshFeed()
  const [sortBy] = useSortBy()
  const [activeUsers, setActiveUsers] = useActiveUsers()
  const [focusedPanel, setFocusedPanel] = useFocusedPanel()

  // Filter activeUsers to only include valid users
  const validActiveUsers = useMemo(() => {
    if (follows.length === 0)
      return []
    const available = new Set(follows.map(follow => follow.githubUserLogin).filter(Boolean))
    return activeUsers.filter(login => available.has(login))
  }, [follows, activeUsers])

  // Sort follows based on sortBy
  const sortedFollows = useMemo(() => {
    const filtered = follows.filter(f => f.githubUserLogin)
    switch (sortBy) {
      case 'latest':
        return [...filtered].sort((a, b) => {
          const aTime = a.latestEntryAt ? new Date(a.latestEntryAt).getTime() : 0
          const bTime = b.latestEntryAt ? new Date(b.latestEntryAt).getTime() : 0
          return bTime - aTime
        })
      default:
        return [...filtered].sort((a, b) => a.githubUserLogin.localeCompare(b.githubUserLogin))
    }
  }, [follows, sortBy])

  // Keyboard navigation
  const handleNavigate = useCallback(
    (direction: 'up' | 'down') => {
      if (focusedPanel !== 'sidebar' || sortedFollows.length === 0)
        return

      const logins = sortedFollows.map(f => f.githubUserLogin)
      const currentLogin = validActiveUsers[0]
      const currentIndex = currentLogin ? logins.indexOf(currentLogin) : -1

      let newIndex: number
      if (direction === 'up') {
        newIndex = currentIndex <= 0 ? 0 : currentIndex - 1
      }
      else {
        newIndex = currentIndex >= logins.length - 1 ? logins.length - 1 : currentIndex + 1
      }

      const newLogin = logins[newIndex]
      if (newLogin) {
        void setActiveUsers([newLogin])
      }
    },
    [focusedPanel, sortedFollows, validActiveUsers, setActiveUsers],
  )

  useKeyboardNavigation(handleNavigate)

  // Auto-select first item when switching to this panel
  const prevFocusedPanel = useRef(focusedPanel)
  useEffect(() => {
    if (prevFocusedPanel.current !== 'sidebar' && focusedPanel === 'sidebar') {
      // Switched to sidebar
      if (validActiveUsers.length === 0 && sortedFollows.length > 0) {
        void setActiveUsers([sortedFollows[0].githubUserLogin])
      }
    }
    prevFocusedPanel.current = focusedPanel
  }, [focusedPanel, validActiveUsers, sortedFollows, setActiveUsers])

  // Scroll to focused item
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (focusedPanel === 'sidebar' && validActiveUsers[0] && listRef.current) {
      const element = listRef.current.querySelector(`[data-user-login="${validActiveUsers[0]}"]`)
      element?.scrollIntoView({ block: 'nearest' })
    }
  }, [focusedPanel, validActiveUsers])

  // Toggle user selection
  const toggleUser = (login: string, multiSelect: boolean) => {
    void setFocusedPanel('sidebar')
    if (multiSelect) {
      if (validActiveUsers.includes(login)) {
        setActiveUsers(validActiveUsers.filter(item => item !== login))
      }
      else {
        setActiveUsers([...validActiveUsers, login])
      }
    }
    else {
      if (validActiveUsers.length === 1 && validActiveUsers[0] === login) {
        setActiveUsers([])
      }
      else {
        setActiveUsers([login])
      }
    }
  }

  if (isLoading) {
    return (
      <ScrollArea className="min-h-0 flex-1">
        <div>
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-center gap-2 border-b px-3 py-2">
              <div className="size-7 shrink-0 animate-pulse rounded-full bg-muted" />
              <Skeleton className="h-4 flex-1" />
            </div>
          ))}
        </div>
      </ScrollArea>
    )
  }

  if (follows.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-start px-4 pt-4">
        <p className="text-sm text-muted-foreground">
          Add a developer to start collecting activity.
        </p>
      </div>
    )
  }

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div ref={listRef}>
        {sortedFollows.map((follow) => {
          const isActive = validActiveUsers.includes(follow.githubUserLogin)
          const isFocused
            = focusedPanel === 'sidebar' && validActiveUsers[0] === follow.githubUserLogin
          return (
            <div key={follow.id} data-user-login={follow.githubUserLogin}>
              <FollowUserItem
                follow={follow}
                isActive={isActive}
                isFocused={isFocused}
                isRemovePending={isRemovePending}
                onToggle={toggleUser}
                onFocus={() => {
                  void setFocusedPanel('sidebar')
                  void setActiveUsers([follow.githubUserLogin])
                }}
                onRefresh={refreshSingleFeed}
                onRemove={removeUser}
              />
            </div>
          )
        })}
      </div>
    </ScrollArea>
  )
}
