import { auth } from '@better-github-feed/auth'
import { db } from '@better-github-feed/db'
import { account } from '@better-github-feed/db/schema/auth'
import { ORPCError } from '@orpc/server'
import { eq } from 'drizzle-orm'

import { createFeedRefresh } from '../feed/feed-refresh'
import { createVisibleFeed } from '../feed/visible-feed'
import {
  createFollowingSync,
  FollowingAuthorizationError,
  FollowingSnapshotTooLargeError,
  FollowingSyncInProgressError,
  FollowingUnavailableError,
} from '../following/following-sync'
import { initializeGithubFollowing } from '../following/initial-following'
import { protectedProcedure } from '../index'
import { fetchGithubFollowing, GithubFollowingError } from './github-following'
import { fetchGithubActivity } from './utils'

const FOLLOWING_SYNC_CONCURRENCY = 3
const FOLLOWING_SYNC_RETRY_ATTEMPTS = 70
const FOLLOWING_SYNC_RETRY_DELAY_MS = 1000
const visibleFeed = createVisibleFeed(db)

async function getGithubAccessToken(userId: string, githubAccountId: string) {
  try {
    const { accessToken } = await auth.api.getAccessToken({
      body: { providerId: 'github', accountId: githubAccountId, userId },
    })
    if (!accessToken) {
      throw new FollowingAuthorizationError()
    }
    return accessToken
  } catch (error) {
    if (error instanceof FollowingAuthorizationError) {
      throw error
    }
    throw new FollowingAuthorizationError()
  }
}

async function getGithubFollowing(accessToken: string) {
  try {
    return await fetchGithubFollowing(accessToken)
  } catch (error) {
    if (!(error instanceof GithubFollowingError)) {
      throw error
    }
    if (error.status === 401) {
      throw new FollowingAuthorizationError()
    }
    throw new FollowingUnavailableError(
      'Failed to load GitHub Following',
      error.status === 403 || error.status === 429 || error.status === undefined,
      error.status === 429 || (error.status === 403 && error.retryAt !== undefined),
      error.retryAt,
    )
  }
}

const followingSync = createFollowingSync({
  database: db,
  getAccessToken: getGithubAccessToken,
  getFollowing: getGithubFollowing,
})
const initialFeedRefresh = createFeedRefresh({ database: db, getActivity: fetchGithubActivity })

export function ensureInitialGithubFollowing(userId: string) {
  return initializeGithubFollowing(userId, {
    syncFollowing: currentUserId => followingSync.sync(currentUserId),
    refreshUninitializedFollowing: currentUserId =>
      initialFeedRefresh.refreshUninitializedFollowing(currentUserId),
  })
}

function mapFollowingSyncError(error: unknown): never {
  if (error instanceof FollowingSyncInProgressError) {
    throw new ORPCError('CONFLICT', { message: error.message })
  }
  if (error instanceof FollowingAuthorizationError) {
    throw new ORPCError('PRECONDITION_FAILED', { message: error.message })
  }
  if (error instanceof FollowingSnapshotTooLargeError) {
    throw new ORPCError('PAYLOAD_TOO_LARGE', { message: error.message })
  }
  if (error instanceof FollowingUnavailableError) {
    if (error.rateLimited) {
      throw new ORPCError('TOO_MANY_REQUESTS', {
        message: error.message,
        data: { retryAt: error.retryAt ?? Date.now() + 60_000 },
      })
    }
    throw new ORPCError(error.retryable ? 'SERVICE_UNAVAILABLE' : 'BAD_GATEWAY', {
      message: error.message,
    })
  }
  throw error
}

async function waitForFollowingSync(userId: string) {
  for (let attempt = 1; attempt <= FOLLOWING_SYNC_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await followingSync.sync(userId)
    } catch (error) {
      if (
        !(error instanceof FollowingSyncInProgressError) ||
        attempt === FOLLOWING_SYNC_RETRY_ATTEMPTS
      ) {
        throw error
      }
      await new Promise(resolve => setTimeout(resolve, FOLLOWING_SYNC_RETRY_DELAY_MS))
    }
  }
  throw new Error('Following Sync retry loop exited unexpectedly')
}

export async function syncAllGithubFollowings() {
  const githubAccounts = await db
    .selectDistinct({ userId: account.userId })
    .from(account)
    .where(eq(account.providerId, 'github'))
  const userIds = githubAccounts.map(githubAccount => githubAccount.userId)
  const summary = {
    attempted: userIds.length,
    succeeded: 0,
    failed: 0,
    following: 0,
    added: 0,
    removed: 0,
  }

  for (let index = 0; index < userIds.length; index += FOLLOWING_SYNC_CONCURRENCY) {
    const batch = userIds.slice(index, index + FOLLOWING_SYNC_CONCURRENCY)
    const results = await Promise.allSettled(batch.map(userId => waitForFollowingSync(userId)))
    for (const result of results) {
      if (result.status === 'rejected') {
        summary.failed += 1
      } else {
        summary.succeeded += 1
        summary.following += result.value.total
        summary.added += result.value.added
        summary.removed += result.value.removed
      }
    }
  }

  return summary
}

export const subscriptionRouter = {
  list: protectedProcedure.subscription.list.handler(({ context }) => {
    return visibleFeed.listFollowing(context.session.user.id)
  }),

  /** @deprecated Retained temporarily for compatibility with legacy clients during rollout. */
  sync: protectedProcedure.subscription.sync.handler(async ({ context }) => {
    try {
      return await followingSync.sync(context.session.user.id)
    } catch (error) {
      mapFollowingSyncError(error)
    }
  }),
}
