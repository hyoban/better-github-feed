import type { FilterGroup } from '@better-github-feed/shared'
import { serializeFilterGroup } from '@better-github-feed/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { orpc } from '@/utils/orpc'

export type UserFilterRule = {
  id: string
  name: string
  filterRule: FilterGroup
  createdAt: Date
  updatedAt: Date
}

export function useFilters() {
  return useQuery(orpc.filter.list.queryOptions())
}

function invalidateFeedQueries(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries(orpc.filter.list.queryOptions())
  queryClient.invalidateQueries({ queryKey: orpc.feed.list.key() })
}

export function useCreateFilter() {
  const queryClient = useQueryClient()

  return useMutation({
    ...orpc.filter.create.mutationOptions(),
    onSuccess: () => invalidateFeedQueries(queryClient),
  })
}

export function useUpdateFilter() {
  const queryClient = useQueryClient()

  return useMutation({
    ...orpc.filter.update.mutationOptions(),
    onSuccess: () => invalidateFeedQueries(queryClient),
  })
}

export function useDeleteFilter() {
  const queryClient = useQueryClient()

  return useMutation({
    ...orpc.filter.delete.mutationOptions(),
    onSuccess: () => invalidateFeedQueries(queryClient),
  })
}

/**
 * Helper to prepare filter data for API calls (for create)
 */
export function prepareFilterPayload(name: string, filterRule: FilterGroup) {
  return {
    body: {
      name,
      filterRule: serializeFilterGroup(filterRule),
    },
  }
}

/**
 * Helper to prepare filter data for API calls (for update)
 */
export function prepareUpdateFilterPayload(id: string, name: string, filterRule: FilterGroup) {
  return {
    params: { id },
    body: {
      name,
      filterRule: serializeFilterGroup(filterRule),
    },
  }
}
