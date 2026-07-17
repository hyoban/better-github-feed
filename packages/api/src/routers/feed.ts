import { db } from '@better-github-feed/db'
import { ORPCError } from '@orpc/server'

import { createActivityCleanup } from '../feed/activity-cleanup'
import { createActivityReconciliation } from '../feed/activity-reconciliation'
import { createFeedRefresh, FeedRefreshTargetNotFoundError } from '../feed/feed-refresh'
import { createVisibleFeed } from '../feed/visible-feed'
import { adminProcedure, protectedProcedure } from '../index'
import { fetchGithubActivity } from './utils'

const visibleFeed = createVisibleFeed(db)
const feedRefresh = createFeedRefresh({ database: db, getActivity: fetchGithubActivity })
const activityCleanup = createActivityCleanup(db)
const activityReconciliation = createActivityReconciliation(db)

export const feedRouter = {
  list: protectedProcedure.feed.list.handler(async ({ context, input }) => {
    return visibleFeed.list({
      userId: context.session.user.id,
      limit: input?.query?.limit,
      cursor: input?.query?.cursor,
      users: input?.query?.users,
      types: input?.query?.types,
    })
  }),

  /** @deprecated Retained temporarily for compatibility with legacy clients during rollout. */
  refresh: protectedProcedure.feed.refresh.handler(async function* ({ context }) {
    for await (const outcome of feedRefresh.refreshFollowing(context.session.user.id)) {
      if (outcome.type === 'refreshed') {
        yield { ...outcome, type: 'success' as const }
      } else if (outcome.type === 'failed') {
        yield { ...outcome, type: 'error' as const }
      } else {
        yield outcome
      }
    }
  }),

  /** @deprecated Retained temporarily for compatibility with legacy clients during rollout. */
  refreshOne: protectedProcedure.feed.refreshOne.handler(async ({ context, input }) => {
    try {
      const result = await feedRefresh.refreshOne(context.session.user.id, input.params.login)
      return result.skipped ? result : { ...result, refreshedAt: result.refreshedAt.toISOString() }
    } catch (error) {
      if (error instanceof FeedRefreshTargetNotFoundError) {
        throw new ORPCError('NOT_FOUND', { message: error.message })
      }
      throw error
    }
  }),

  clear: protectedProcedure.feed.clear.handler(async ({ context }) => {
    return visibleFeed.clear(context.session.user.id)
  }),

  cleanup: adminProcedure.feed.cleanup.handler(async ({ input }) => {
    const maxItems = input?.body?.maxItemsPerUser ?? 200
    return cleanupOldFeedItems(maxItems)
  }),
}

/**
 * Clean up old feed items - used by cron job
 * Keeps only the most recent N items per GitHub user
 */
export async function cleanupOldFeedItems(maxItemsPerUser = 200) {
  return activityCleanup.cleanup(maxItemsPerUser)
}

export async function reconcileLegacyFeedItems() {
  return activityReconciliation.reconcileIfNeeded()
}

/**
 * Refresh feeds for GitHub users followed by an active app user.
 * Only refreshes the 50 least recently refreshed GitHub users each run.
 */
export async function refreshAllUsersFeeds() {
  return feedRefresh.refreshAllActive()
}
