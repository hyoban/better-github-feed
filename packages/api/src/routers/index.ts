import type { RouterClient } from '@orpc/server'
import { db } from '@better-github-feed/db'

import { os, protectedProcedure } from '../index'
import { createUserStateCompaction } from '../local-feed/user-state-compaction'
import {
  cleanupOldFeedItems,
  feedRouter,
  reconcileLegacyFeedItems,
  refreshAllUsersFeeds,
} from './feed'
import { filterRouter } from './filter'
import { healthRouter } from './health'
import { localFeedV1Router } from '../local-feed/router'
import { subscriptionRouter, syncAllGithubFollowings } from './subscription'

const userStateCompaction = createUserStateCompaction(db)

function compactUserStateSync() {
  return userStateCompaction.compact()
}

export const appRouter = os.router({
  health: healthRouter,
  subscription: subscriptionRouter,
  feed: feedRouter,
  filter: filterRouter,
  localFeedV1: localFeedV1Router,
  privateData: protectedProcedure.privateData.handler(({ context }) => {
    return {
      message: 'This is private',
      user: context.session?.user,
    }
  }),
})

export type AppRouter = typeof appRouter
export type AppRouterClient = RouterClient<typeof appRouter>

export {
  cleanupOldFeedItems,
  compactUserStateSync,
  reconcileLegacyFeedItems,
  refreshAllUsersFeeds,
  syncAllGithubFollowings,
}
