import assert from 'node:assert/strict'

import { InfiniteQueryObserver, QueryClient } from '@tanstack/react-query'
import { describe, it } from 'vite-plus/test'

import { getActivityQueryOptions } from './activity-query-options'

type ActivityPage = {
  items: string[]
  types: string[]
  typeCounts: Record<string, number>
}

function createOptions(queryKey: string[], queryFn: () => Promise<ActivityPage>) {
  return getActivityQueryOptions({
    queryKey,
    queryFn,
    initialPageParam: undefined,
    getNextPageParam: () => undefined,
    retry: false,
  })
}

describe('Activity Query', () => {
  it('keeps type filters visible while a new filter query is loading', async () => {
    const queryClient = new QueryClient()
    const initialPage: ActivityPage = {
      items: ['activity-1'],
      types: ['star', 'pr_merged'],
      typeCounts: { star: 269, pr_merged: 270 },
    }
    const initialOptions = createOptions(['activity', 'all'], async () => initialPage)
    await queryClient.fetchInfiniteQuery(initialOptions)

    const observer = new InfiniteQueryObserver(queryClient, initialOptions)
    const unsubscribe = observer.subscribe(() => undefined)
    let resolveNextPage: (page: ActivityPage) => void = () => undefined
    const nextPage = new Promise<ActivityPage>(resolve => {
      resolveNextPage = resolve
    })

    try {
      observer.setOptions(createOptions(['activity', 'pr_merged'], () => nextPage))

      assert.deepEqual(observer.getCurrentResult().data?.pages[0]?.types, initialPage.types)
    } finally {
      resolveNextPage(initialPage)
      unsubscribe()
      queryClient.clear()
    }
  })
})
