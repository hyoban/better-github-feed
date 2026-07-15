import { db } from '@better-github-feed/db'
import { feedItem, githubUser } from '@better-github-feed/db/schema/github'
import { ORPCError } from '@orpc/server'
import { and, desc, eq, lt } from 'drizzle-orm'

import { createFeedRefresh, FeedRefreshTargetNotFoundError } from '../feed/feed-refresh'
import { createVisibleFeed } from '../feed/visible-feed'
import { adminProcedure, protectedProcedure } from '../index'
import { fetchGithubActivity } from './utils'

const visibleFeed = createVisibleFeed(db)
const feedRefresh = createFeedRefresh({ database: db, getActivity: fetchGithubActivity })

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
  // Get all github users
  const users = await db.select({ login: githubUser.login }).from(githubUser)

  let totalDeleted = 0

  for (const user of users) {
    const login = user.login

    // Get the publishedAt of the Nth newest item (the cutoff point)
    const cutoffResult = await db
      .select({ publishedAt: feedItem.publishedAt })
      .from(feedItem)
      .where(eq(feedItem.githubUserLogin, login))
      .orderBy(desc(feedItem.publishedAt))
      .limit(1)
      .offset(maxItemsPerUser - 1)

    const cutoff = cutoffResult[0]?.publishedAt
    if (!cutoff) {
      // Less than maxItems, nothing to delete
      continue
    }

    // Delete items older than the cutoff
    const deleted = await db
      .delete(feedItem)
      .where(and(eq(feedItem.githubUserLogin, login), lt(feedItem.publishedAt, cutoff)))

    totalDeleted += deleted.meta.changes
  }

  return { deleted: totalDeleted }
}

/**
 * Refresh feeds for GitHub users followed by an active app user.
 * Only refreshes the 50 least recently refreshed GitHub users each run.
 */
export async function refreshAllUsersFeeds() {
  return feedRefresh.refreshAllActive()
}
