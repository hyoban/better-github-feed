import type { FilterGroup } from '@better-github-feed/shared'
import { useMutation, useQuery } from '@tanstack/react-query'

import type { CacheInvalidationResult } from '@/lib/cache-invalidation'
import { warnIfCacheInvalidationFailed } from '@/lib/cache-invalidation'
import { feedMutations, orpc } from '@/utils/orpc'

type UserFilterRuleBase = {
  id: string
  name: string
  createdAt: Date
  updatedAt: Date
}
export type UserFilterRule = UserFilterRuleBase &
  ({ isValid: true; filterRule: FilterGroup } | { isValid: false; filterRule: null })

// feedMutations owns cache invalidation; these hooks only report its outcome.
function onFilterCreated(result: CacheInvalidationResult) {
  warnIfCacheInvalidationFailed(result, 'Filter created, but cached data could not be refreshed')
}

function onFilterUpdated(result: CacheInvalidationResult) {
  warnIfCacheInvalidationFailed(result, 'Filter updated, but cached data could not be refreshed')
}

function onFilterDeleted(result: CacheInvalidationResult) {
  warnIfCacheInvalidationFailed(result, 'Filter deleted, but cached data could not be refreshed')
}

export function useFilters() {
  return useQuery(orpc.filter.list.queryOptions())
}

export function useCreateFilter() {
  return useMutation({
    mutationFn: (input: { body: { name: string; filterRule: FilterGroup } }) =>
      feedMutations.createFilter(input.body),
    onSuccess: onFilterCreated,
  })
}

export function useUpdateFilter() {
  return useMutation({
    mutationFn: (input: {
      params: { id: string }
      body: { name: string; filterRule: FilterGroup }
    }) => feedMutations.updateFilter(input.params.id, input.body),
    onSuccess: onFilterUpdated,
  })
}

export function useDeleteFilter() {
  return useMutation({
    mutationFn: (input: { params: { id: string } }) => feedMutations.deleteFilter(input.params.id),
    onSuccess: onFilterDeleted,
  })
}
