import { useInfiniteQuery } from '@tanstack/react-query'
import { useMemo } from 'react'

import { orpc } from '@/utils/orpc'

import { getActivityQueryOptions } from './activity-query-options'

export function useActivity(
  userId: string | undefined,
  activeUsers: string[],
  activeTypes: string[],
) {
  const usersParam = activeUsers.length > 0 ? activeUsers : undefined
  const typesParam = activeTypes.length > 0 ? activeTypes : undefined
  const enabled = !!userId

  const options = orpc.feed.list.infiniteOptions({
    input: (cursor: string | undefined) => ({
      query: {
        cursor,
        users: usersParam,
        types: typesParam,
      },
    }),
    initialPageParam: undefined,
    getNextPageParam: lastPage => lastPage.nextCursor ?? undefined,
    enabled,
  })
  const query = useInfiniteQuery(
    getActivityQueryOptions({
      ...options,
      queryKey: [...options.queryKey, { userId }],
    }),
  )

  const items = useMemo(
    () => (enabled ? (query.data?.pages.flatMap(page => page.items) ?? []) : []),
    [enabled, query.data],
  )

  const types = enabled ? (query.data?.pages[0]?.types ?? []) : []

  const typeCounts = useMemo(() => {
    const counts = enabled ? (query.data?.pages[0]?.typeCounts ?? {}) : {}
    return new Map(Object.entries(counts))
  }, [enabled, query.data])

  return {
    items,
    types,
    typeCounts,
    isLoading: enabled && query.isLoading,
    isFetching: enabled && query.isFetching,
    hasNextPage: enabled && (query.hasNextPage ?? false),
    isFetchingNextPage: enabled && query.isFetchingNextPage,
    fetchNextPage: () => query.fetchNextPage(),
  }
}
