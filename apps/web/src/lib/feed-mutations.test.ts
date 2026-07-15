import assert from 'node:assert/strict'

import { QueryClient } from '@tanstack/react-query'
import { describe, it } from 'vite-plus/test'

import type { FeedMutationRemote } from './feed-mutations'
import { createFeedMutationCache, createFeedMutations } from './feed-mutations'

describe('Feed Mutation Coordination', () => {
  it('reconciles only the caches affected by Clear Feed', async () => {
    const queryClient = new QueryClient()
    const keys = {
      feed: ['feed'],
      following: ['following'],
      filters: ['filters'],
    } as const
    queryClient.setQueryData(keys.feed, ['activity'])
    queryClient.setQueryData(keys.following, ['alice'])
    queryClient.setQueryData(keys.filters, ['hide-stars'])
    const unsupported = async (): Promise<never> => {
      throw new Error('Not used by this test')
    }
    const remote: FeedMutationRemote = {
      syncFollowing: unsupported,
      refreshOne: unsupported,
      refreshFollowing: unsupported,
      clearFeed: async () => ({ ok: true }),
      createFilter: unsupported,
      updateFilter: unsupported,
      deleteFilter: unsupported,
    }
    const mutations = createFeedMutations({
      remote,
      cache: createFeedMutationCache(queryClient, keys),
    })

    const result = await mutations.clearFeed()

    assert.equal(result.cacheStatus, 'fresh')
    assert.equal(queryClient.getQueryState(keys.feed)?.isInvalidated, true)
    assert.equal(queryClient.getQueryState(keys.following)?.isInvalidated, true)
    assert.equal(queryClient.getQueryState(keys.filters)?.isInvalidated, false)
  })

  it('reconciles caches after a streaming refresh partially succeeds', async () => {
    const invalidatedScopes: string[][] = []
    const unsupported = async (): Promise<never> => {
      throw new Error('Not used by this test')
    }
    const remote: FeedMutationRemote = {
      syncFollowing: unsupported,
      refreshOne: unsupported,
      refreshFollowing: async () =>
        (async function* () {
          yield { type: 'success' as const, login: 'alice', index: 0, itemCount: 1 }
          throw new Error('stream interrupted')
        })(),
      clearFeed: unsupported,
      createFilter: unsupported,
      updateFilter: unsupported,
      deleteFilter: unsupported,
    }
    const mutations = createFeedMutations({
      remote,
      cache: {
        invalidate: async scopes => {
          invalidatedScopes.push([...scopes])
        },
      },
    })

    await assert.rejects(
      mutations.refreshFollowing(() => undefined),
      /stream interrupted/,
    )
    assert.deepEqual(invalidatedScopes, [['following', 'feed']])
  })

  it('treats refresh and Clear Feed as one conflicting mutation domain', async () => {
    let finishRefresh: (() => void) | undefined
    const refreshStarted = new Promise<void>(resolve => {
      finishRefresh = resolve
    })
    const unsupported = async (): Promise<never> => {
      throw new Error('Not used by this test')
    }
    const remote: FeedMutationRemote = {
      syncFollowing: unsupported,
      refreshOne: async () => {
        await refreshStarted
        return { skipped: true }
      },
      refreshFollowing: unsupported,
      clearFeed: async () => ({ ok: true }),
      createFilter: unsupported,
      updateFilter: unsupported,
      deleteFilter: unsupported,
    }
    const mutations = createFeedMutations({
      remote,
      cache: { invalidate: async () => undefined },
    })

    const refresh = mutations.refreshOne('alice')
    await assert.rejects(mutations.clearFeed(), /conflicting feed mutation/)
    finishRefresh?.()
    await refresh
  })
})
