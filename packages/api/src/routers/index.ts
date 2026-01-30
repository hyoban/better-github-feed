import type { RouterClient } from '@orpc/server'

import { protectedProcedure } from '../index'
import { cleanupOldFeedItems, feedRouter, refreshAllUsersFeeds } from './feed'
import { filterRouter } from './filter'
import { healthRouter } from './health'
import { subscriptionRouter } from './subscription'

export const appRouter = {
  health: healthRouter,
  subscription: subscriptionRouter,
  feed: feedRouter,
  filter: filterRouter,
  privateData: protectedProcedure.handler(({ context }) => {
    return {
      message: 'This is private',
      user: context.session?.user,
    }
  }),
}

export type AppRouter = typeof appRouter
export type AppRouterClient = RouterClient<typeof appRouter>

export { cleanupOldFeedItems, refreshAllUsersFeeds }
