import { auth } from '@better-github-feed/auth'
import { db } from '@better-github-feed/db'
import { account } from '@better-github-feed/db/schema/auth'
import {
  feedItem,
  githubUser,
  subscription,
  userFilter,
} from '@better-github-feed/db/schema/github'
import { ORPCError } from '@orpc/server'
import { and, desc, eq, isNull, lt, or, sql } from 'drizzle-orm'

import { deserializeFilterGroup, filterRuleToDrizzleWhere } from '../filter/drizzle-transform'
import { protectedProcedure } from '../index'
import {
  buildFollowingDiff,
  fetchGithubFollowing,
  GithubFollowingError,
  GithubFollowingSyncInProgressError,
  serializeFollowingSnapshotChunks,
  syncGithubFollowingsForUsers,
  waitForGithubFollowingSync,
} from './github-following'

// Each chunk adds two batch statements. This leaves room under D1 Free's per-invocation limit.
const MAX_SNAPSHOT_CHUNKS = 16
const FOLLOWING_SYNC_CLAIM_TIMEOUT_MS = 10 * 60 * 1000

async function getGithubAccessToken(userId: string) {
  try {
    const { accessToken } = await auth.api.getAccessToken({
      body: {
        providerId: 'github',
        userId,
      },
    })

    if (!accessToken) {
      throw new Error('GitHub access token is missing')
    }

    return accessToken
  }
  catch {
    throw new ORPCError('PRECONDITION_FAILED', {
      message: 'Reconnect your GitHub account before syncing follows',
    })
  }
}

function toGithubSyncError(error: GithubFollowingError) {
  if (error.status === 401) {
    return new ORPCError('PRECONDITION_FAILED', {
      message: 'GitHub authorization expired. Sign out and sign in again.',
    })
  }

  if (error.status === 403 || error.status === 429) {
    return new ORPCError('SERVICE_UNAVAILABLE', {
      message: 'GitHub cannot sync your follows right now. Try again later.',
    })
  }

  return new ORPCError('BAD_GATEWAY', {
    message: 'Failed to load your GitHub follows',
  })
}

async function performGithubFollowingSync(userId: string) {
  const accessToken = await getGithubAccessToken(userId)

  let following
  try {
    following = await fetchGithubFollowing(accessToken)
  }
  catch (error) {
    if (error instanceof GithubFollowingError) {
      throw toGithubSyncError(error)
    }
    throw error
  }

  const currentRows = await db
    .select({
      id: subscription.id,
      githubUserLogin: subscription.githubUserLogin,
      createdAt: subscription.createdAt,
    })
    .from(subscription)
    .where(eq(subscription.userId, userId))

  const { toAdd, toRemove } = buildFollowingDiff(
    currentRows.map(row => row.githubUserLogin),
    following,
  )

  const now = Date.now()
  const currentByLogin = new Map(currentRows.map(row => [row.githubUserLogin, row]))
  const snapshot = following.map((user) => {
    const current = currentByLogin.get(user.login)
    return {
      githubId: user.id,
      login: user.login,
      subscriptionId: current?.id ?? crypto.randomUUID(),
      createdAt: current?.createdAt.getTime() ?? now,
    }
  })
  const snapshotJsonChunks = serializeFollowingSnapshotChunks(snapshot)
  if (snapshotJsonChunks.length > MAX_SNAPSHOT_CHUNKS) {
    throw new ORPCError('PAYLOAD_TOO_LARGE', {
      message: 'GitHub following list is too large to sync',
    })
  }

  const upsertGithubUsers = snapshotJsonChunks.map(snapshotJson => db
    .insert(githubUser)
    .select(sql`
        select
          json_extract(value, '$.login') as login,
          json_extract(value, '$.githubId') as id,
          null as last_refreshed_at,
          null as refresh_claimed_at,
          ${now} as created_at
        from json_each(${snapshotJson})
        where true
      `)
    .onConflictDoUpdate({
      target: githubUser.login,
      set: { id: sql`excluded.id` },
    }))

  const replaceSubscriptions = snapshotJsonChunks.map(snapshotJson => db
    .insert(subscription)
    .select(sql`
        select
          json_extract(value, '$.subscriptionId'),
          ${userId},
          json_extract(value, '$.login'),
          json_extract(value, '$.createdAt')
        from json_each(${snapshotJson})
      `))

  const firstUpsert = upsertGithubUsers[0]
  if (!firstUpsert) {
    throw new Error('GitHub following snapshot is missing')
  }

  await db.batch([
    firstUpsert,
    ...upsertGithubUsers.slice(1),
    db.delete(subscription).where(eq(subscription.userId, userId)),
    ...replaceSubscriptions,
  ])

  return {
    total: following.length,
    added: toAdd.length,
    removed: toRemove.length,
  }
}

async function getGithubAccount(userId: string) {
  const githubAccounts = await db
    .select({ id: account.id })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, 'github')))
    .limit(1)

  const githubAccount = githubAccounts[0]
  if (!githubAccount) {
    throw new ORPCError('PRECONDITION_FAILED', {
      message: 'Reconnect your GitHub account before syncing follows',
    })
  }

  return githubAccount
}

async function claimGithubFollowingSync(accountId: string, claimedAt: Date) {
  const claimCutoff = new Date(claimedAt.getTime() - FOLLOWING_SYNC_CLAIM_TIMEOUT_MS)
  const result = await db
    .update(account)
    .set({ followingSyncClaimedAt: claimedAt })
    .where(and(
      eq(account.id, accountId),
      or(
        isNull(account.followingSyncClaimedAt),
        lt(account.followingSyncClaimedAt, claimCutoff),
      ),
    ))

  return result.meta.changes > 0
}

async function tryReleaseGithubFollowingSync(accountId: string, claimedAt: Date) {
  try {
    await db
      .update(account)
      .set({ followingSyncClaimedAt: null })
      .where(and(
        eq(account.id, accountId),
        eq(account.followingSyncClaimedAt, claimedAt),
      ))
  }
  catch {
    // Leave the claim in place until it expires if it cannot be released.
  }
}

async function syncGithubFollowing(userId: string) {
  const githubAccount = await getGithubAccount(userId)
  const claimedAt = new Date()
  const claimed = await claimGithubFollowingSync(githubAccount.id, claimedAt)
  if (!claimed) {
    throw new GithubFollowingSyncInProgressError()
  }

  try {
    return await performGithubFollowingSync(userId)
  }
  finally {
    await tryReleaseGithubFollowingSync(githubAccount.id, claimedAt)
  }
}

export async function syncAllGithubFollowings() {
  const githubAccounts = await db
    .selectDistinct({ userId: account.userId })
    .from(account)
    .where(eq(account.providerId, 'github'))

  return syncGithubFollowingsForUsers(
    githubAccounts.map(githubAccount => githubAccount.userId),
    userId => waitForGithubFollowingSync(() => syncGithubFollowing(userId)),
  )
}

export const subscriptionRouter = {
  list: protectedProcedure.subscription.list.handler(async ({ context }) => {
    const userId = context.session.user.id
    const rows = await db
      .select({
        id: subscription.id,
        githubUserLogin: subscription.githubUserLogin,
        githubUserId: githubUser.id,
        lastRefreshedAt: githubUser.lastRefreshedAt,
        createdAt: subscription.createdAt,
      })
      .from(subscription)
      .innerJoin(githubUser, eq(subscription.githubUserLogin, githubUser.login))
      .where(eq(subscription.userId, userId))
      .orderBy(desc(subscription.createdAt))

    const githubUserLogins = rows.map(row => row.githubUserLogin)

    const userFilters = await db.select().from(userFilter).where(eq(userFilter.userId, userId))
    const filterConditions = []
    for (const userFilterRow of userFilters) {
      try {
        const rule = deserializeFilterGroup(userFilterRow.filterRule)
        const where = filterRuleToDrizzleWhere(rule)
        if (where) {
          filterConditions.push(where)
        }
      }
      catch {
        // Skip invalid rules
      }
    }

    const statsConditions = [eq(subscription.userId, userId), eq(feedItem.hidden, false)]
    if (filterConditions.length > 0) {
      statsConditions.push(and(...filterConditions)!)
    }

    const stats
      = githubUserLogins.length > 0
        ? await db
            .select({
              githubUserLogin: feedItem.githubUserLogin,
              count: sql<string>`count(*)`.as('count'),
              latestEntryAt: sql<string>`max(${feedItem.publishedAt})`.as('latestEntryAt'),
            })
            .from(feedItem)
            .innerJoin(subscription, eq(feedItem.githubUserLogin, subscription.githubUserLogin))
            .where(and(...statsConditions))
            .groupBy(feedItem.githubUserLogin)
        : []

    const statsMap = new Map(
      stats.map(row => [
        row.githubUserLogin,
        {
          count: Number(row.count) || 0,
          latestEntryAt: row.latestEntryAt ? new Date(row.latestEntryAt) : null,
        },
      ]),
    )

    return rows.map(row => ({
      ...row,
      itemCount: statsMap.get(row.githubUserLogin)?.count ?? 0,
      latestEntryAt: statsMap.get(row.githubUserLogin)?.latestEntryAt ?? null,
    }))
  }),

  sync: protectedProcedure.subscription.sync.handler(async ({ context }) => {
    try {
      return await syncGithubFollowing(context.session.user.id)
    }
    catch (error) {
      if (error instanceof GithubFollowingSyncInProgressError) {
        throw new ORPCError('CONFLICT', { message: error.message })
      }
      throw error
    }
  }),
}
