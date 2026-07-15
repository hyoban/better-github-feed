import type { FilterGroup } from '@better-github-feed/shared'
import { useMutation, useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'

import { feedMutations, orpc } from '@/utils/orpc'

type UserFilterRuleBase = {
  id: string
  name: string
  createdAt: Date
  updatedAt: Date
}
export type UserFilterRule = UserFilterRuleBase &
  ({ isValid: true; filterRule: FilterGroup } | { isValid: false; filterRule: null })

export function useFilters() {
  return useQuery(orpc.filter.list.queryOptions())
}

export function useCreateFilter() {
  return useMutation({
    mutationFn: (input: { body: { name: string; filterRule: FilterGroup } }) =>
      feedMutations.createFilter(input.body),
    onSuccess: result => {
      if (result.cacheStatus === 'stale') {
        toast.warning('Filter created, but cached data could not be refreshed')
      }
    },
  })
}

export function useUpdateFilter() {
  return useMutation({
    mutationFn: (input: {
      params: { id: string }
      body: { name: string; filterRule: FilterGroup }
    }) => feedMutations.updateFilter(input.params.id, input.body),
    onSuccess: result => {
      if (result.cacheStatus === 'stale') {
        toast.warning('Filter updated, but cached data could not be refreshed')
      }
    },
  })
}

export function useDeleteFilter() {
  return useMutation({
    mutationFn: (input: { params: { id: string } }) => feedMutations.deleteFilter(input.params.id),
    onSuccess: result => {
      if (result.cacheStatus === 'stale') {
        toast.warning('Filter deleted, but cached data could not be refreshed')
      }
    },
  })
}
