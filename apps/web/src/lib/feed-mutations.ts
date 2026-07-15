import type { RefreshProgressEvent } from '@better-github-feed/contract'
import type { FilterGroup } from '@better-github-feed/shared'
import type { QueryClient, QueryKey } from '@tanstack/react-query'

type FilterInput = { name: string; filterRule: FilterGroup }

export type FeedMutationRemote = {
  syncFollowing: () => Promise<{ total: number; added: number; removed: number }>
  refreshOne: (
    login: string,
  ) => Promise<{ skipped: true } | { skipped: false; refreshedAt: string; itemCount: number }>
  refreshFollowing: () => Promise<AsyncIterable<RefreshProgressEvent>>
  clearFeed: () => Promise<{ ok: true }>
  createFilter: (input: FilterInput) => Promise<unknown>
  updateFilter: (id: string, input: FilterInput) => Promise<unknown>
  deleteFilter: (id: string) => Promise<unknown>
}

type CacheScope = 'feed' | 'following' | 'filters'
type MutationCache = {
  invalidate: (scopes: readonly CacheScope[]) => Promise<void>
}

type FeedMutationKeys = Record<CacheScope, QueryKey>
type CacheStatus = 'fresh' | 'stale'

const cacheDependencies = {
  syncFollowing: ['following', 'feed'],
  refresh: ['following', 'feed'],
  clearFeed: ['following', 'feed'],
  userFilter: ['filters', 'following', 'feed'],
} as const satisfies Record<string, readonly CacheScope[]>

export class FeedMutationInProgressError extends Error {
  constructor() {
    super('A conflicting feed mutation is already in progress')
    this.name = 'FeedMutationInProgressError'
  }
}

export function createFeedMutationCache(
  queryClient: QueryClient,
  keys: FeedMutationKeys,
): MutationCache {
  return {
    async invalidate(scopes) {
      await Promise.all(
        scopes.map(scope =>
          queryClient.invalidateQueries({ queryKey: keys[scope] }, { throwOnError: true }),
        ),
      )
    },
  }
}

export function createFeedMutations({
  remote,
  cache,
}: {
  remote: FeedMutationRemote
  cache: MutationCache
}) {
  const running = new Set<string>()

  async function run<T>(
    lock: string,
    scopes: readonly CacheScope[],
    mutation: () => Promise<T>,
  ): Promise<{ data: T; cacheStatus: CacheStatus }> {
    if (running.has(lock)) {
      throw new FeedMutationInProgressError()
    }
    running.add(lock)
    try {
      let data: T
      try {
        data = await mutation()
      } catch (error) {
        try {
          await cache.invalidate(scopes)
        } catch {
          // Preserve the mutation error while leaving the cache marked stale.
        }
        throw error
      }
      let cacheStatus: CacheStatus = 'fresh'
      try {
        await cache.invalidate(scopes)
      } catch {
        cacheStatus = 'stale'
      }
      return { data, cacheStatus }
    } finally {
      running.delete(lock)
    }
  }

  return {
    syncFollowing() {
      return run('following-sync', cacheDependencies.syncFollowing, remote.syncFollowing)
    },

    refreshOne(login: string) {
      return run('feed-data', cacheDependencies.refresh, () => remote.refreshOne(login))
    },

    refreshFollowing(onOutcome: (outcome: RefreshProgressEvent) => void | Promise<void>) {
      return run('feed-data', cacheDependencies.refresh, async () => {
        const outcomes = await remote.refreshFollowing()
        for await (const outcome of outcomes) {
          await onOutcome(outcome)
        }
      })
    },

    clearFeed() {
      return run('feed-data', cacheDependencies.clearFeed, remote.clearFeed)
    },

    createFilter(input: FilterInput) {
      return run('user-filter', cacheDependencies.userFilter, () => remote.createFilter(input))
    },

    updateFilter(id: string, input: FilterInput) {
      return run('user-filter', cacheDependencies.userFilter, () => remote.updateFilter(id, input))
    },

    deleteFilter(id: string) {
      return run('user-filter', cacheDependencies.userFilter, () => remote.deleteFilter(id))
    },
  }
}
