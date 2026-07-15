import { db } from '@better-github-feed/db'
import { user as appUser } from '@better-github-feed/db/schema/auth'
import {
  feedItem,
  githubUser,
  subscription,
  userFilter,
} from '@better-github-feed/db/schema/github'
import { ORPCError } from '@orpc/server'
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm'

import { deserializeFilterGroup, filterRuleToDrizzleWhere } from '../filter/drizzle-transform'
import { adminProcedure, protectedProcedure } from '../index'
import {
  REFRESH_CLAIM_TIMEOUT_MS,
  REFRESH_COOLDOWN_MS,
  shouldSkipRefresh,
} from './refresh-cooldown'
import type { ActivityError, RefreshProgressEvent } from './utils'
import { chunkArray, fetchGithubActivity, mapFeedItemRow, normalizeLogin } from './utils'

type RefreshCandidate = {
  login: string
  lastRefreshedAt: Date | null
  refreshClaimedAt: Date | null
}

async function claimRefresh(login: string, claimedAt: Date) {
  const cooldownCutoff = new Date(claimedAt.getTime() - REFRESH_COOLDOWN_MS)
  const claimCutoff = new Date(claimedAt.getTime() - REFRESH_CLAIM_TIMEOUT_MS)
  const result = await db
    .update(githubUser)
    .set({ refreshClaimedAt: claimedAt })
    .where(
      and(
        eq(githubUser.login, login),
        or(isNull(githubUser.lastRefreshedAt), lt(githubUser.lastRefreshedAt, cooldownCutoff)),
        or(isNull(githubUser.refreshClaimedAt), lt(githubUser.refreshClaimedAt, claimCutoff)),
      ),
    )

  return result.meta.changes > 0
}

async function claimRefreshableUsers<T extends RefreshCandidate>(users: T[], claimedAt: Date) {
  const results = await Promise.allSettled(
    users.map(async user => ({
      user,
      claimed:
        !shouldSkipRefresh(user.lastRefreshedAt, user.refreshClaimedAt, claimedAt) &&
        (await claimRefresh(user.login, claimedAt)),
    })),
  )

  const claimedUsers: T[] = []
  let claimFailed = false
  let claimError: unknown

  for (const result of results) {
    if (result.status === 'rejected') {
      claimFailed = true
      claimError ??= result.reason
    } else if (result.value.claimed) {
      claimedUsers.push(result.value.user)
    }
  }

  if (claimFailed) {
    await Promise.all(claimedUsers.map(user => tryReleaseRefreshClaim(user, claimedAt)))
    // oxlint-disable-next-line no-throw-literal -- Promise rejection reasons may be any value.
    throw claimError
  }

  return claimedUsers
}

async function tryReleaseRefreshClaim(user: RefreshCandidate, claimedAt: Date) {
  try {
    await db
      .update(githubUser)
      .set({ refreshClaimedAt: null })
      .where(and(eq(githubUser.login, user.login), eq(githubUser.refreshClaimedAt, claimedAt)))
  } catch {
    // Leave the cooldown in place if the failed refresh claim cannot be released.
  }
}

async function refreshGithubUser(user: RefreshCandidate, claimedAt: Date) {
  const { login } = user

  try {
    const { items, githubId } = await fetchGithubActivity(login)
    const rows = items.map(item => ({
      id: item.id,
      githubUserLogin: login,
      title: item.title,
      link: item.link,
      repo: item.repo,
      type: item.type,
      summary: item.summary,
      content: item.content,
      publishedAt: new Date(item.publishedAtMs),
    }))

    const chunks = chunkArray(rows, 8)
    for (const chunk of chunks) {
      if (chunk.length === 0) {
        continue
      }
      await db.insert(feedItem).values(chunk).onConflictDoNothing()
    }

    const refreshedAt = new Date()
    const updateData: { lastRefreshedAt: Date; refreshClaimedAt: null; id?: string } = {
      lastRefreshedAt: refreshedAt,
      refreshClaimedAt: null,
    }
    if (githubId) {
      updateData.id = githubId
    }

    // Only the current claim may complete the refresh. An expired claim must not overwrite a newer
    // refresh timestamp.
    const result = await db
      .update(githubUser)
      .set(updateData)
      .where(and(eq(githubUser.login, login), eq(githubUser.refreshClaimedAt, claimedAt)))

    if (result.meta.changes === 0) {
      throw new Error(`Refresh for ${login} was superseded by a newer request`)
    }

    return { refreshedAt, itemCount: items.length }
  } catch (error) {
    await tryReleaseRefreshClaim(user, claimedAt)
    throw error
  }
}

export const feedRouter = {
  list: protectedProcedure.feed.list.handler(async ({ context, input }) => {
    const userId = context.session.user.id
    const limit = input?.query?.limit ?? 20
    const cursor = input?.query?.cursor
    const usersFilter = input?.query?.users ?? []
    const typeFilter = input?.query?.types ?? []

    // Load user's filter rules from DB
    const userFilters = await db.select().from(userFilter).where(eq(userFilter.userId, userId))

    // Build dynamic filter conditions
    const filterConditions = []

    // Apply user rules
    for (const uf of userFilters) {
      try {
        const rule = deserializeFilterGroup(uf.filterRule)
        const where = filterRuleToDrizzleWhere(rule)
        if (where) filterConditions.push(where)
      } catch {
        // Skip invalid rules
      }
    }

    // Build query with optional cursor filter
    const baseQuery = db
      .select({
        id: feedItem.id,
        githubUserLogin: githubUser.login,
        title: feedItem.title,
        link: feedItem.link,
        repo: feedItem.repo,
        type: feedItem.type,
        summary: feedItem.summary,
        content: feedItem.content,
        publishedAt: feedItem.publishedAt,
      })
      .from(feedItem)
      .innerJoin(githubUser, eq(feedItem.githubUserLogin, githubUser.login))
      .innerJoin(
        subscription,
        and(
          eq(feedItem.githubUserLogin, subscription.githubUserLogin),
          eq(subscription.userId, userId),
        ),
      )

    // Build filter conditions
    const conditions = []
    // Apply dynamic filter conditions
    if (filterConditions.length > 0) {
      conditions.push(and(...filterConditions))
    }
    if (cursor) {
      conditions.push(sql`${feedItem.publishedAt} < ${cursor}`)
    }
    if (usersFilter.length > 0) {
      conditions.push(inArray(githubUser.login, usersFilter))
    }
    if (typeFilter.length > 0) {
      conditions.push(inArray(feedItem.type, typeFilter))
    }

    const rows = await baseQuery
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(feedItem.publishedAt))
      .limit(limit + 1)

    // Check if there are more items
    const hasMore = rows.length > limit
    const itemRows = hasMore ? rows.slice(0, limit) : rows

    const items = itemRows.map(row => mapFeedItemRow(row))

    // Get next cursor from last item
    const lastItem = items[items.length - 1]
    const nextCursor = hasMore && lastItem ? lastItem.publishedAtMs : null

    // Get all types with counts (only on first page for efficiency)
    let types: string[] = []
    let typeCounts: Record<string, number> = {}
    if (!cursor) {
      // Build conditions for type counts (respects user filter but not type filter)
      const typeCountConditions = []
      // Apply dynamic filter conditions for type counts too
      if (filterConditions.length > 0) {
        typeCountConditions.push(and(...filterConditions))
      }
      if (usersFilter.length > 0) {
        typeCountConditions.push(inArray(githubUser.login, usersFilter))
      }

      const typeRows = await db
        .select({
          type: feedItem.type,
          count: sql<string>`count(*)`.as('count'),
        })
        .from(feedItem)
        .innerJoin(githubUser, eq(feedItem.githubUserLogin, githubUser.login))
        .innerJoin(
          subscription,
          and(
            eq(feedItem.githubUserLogin, subscription.githubUserLogin),
            eq(subscription.userId, userId),
          ),
        )
        .where(typeCountConditions.length > 0 ? and(...typeCountConditions) : undefined)
        .groupBy(feedItem.type)

      types = typeRows.map(row => row.type)
      typeCounts = Object.fromEntries(typeRows.map(row => [row.type, Number(row.count) || 0]))
    }

    return {
      items,
      nextCursor,
      hasMore,
      types,
      typeCounts,
    }
  }),

  refresh: protectedProcedure.feed.refresh.handler(async function* ({ context }) {
    const userId = context.session.user.id
    // Get all GitHub users synced from this user's following list
    const subs = await db
      .select({
        login: subscription.githubUserLogin,
        lastRefreshedAt: githubUser.lastRefreshedAt,
        refreshClaimedAt: githubUser.refreshClaimedAt,
      })
      .from(subscription)
      .innerJoin(githubUser, eq(subscription.githubUserLogin, githubUser.login))
      .where(eq(subscription.userId, userId))
      .orderBy(asc(githubUser.lastRefreshedAt))

    const claimedAt = new Date()
    const usersToRefresh = await claimRefreshableUsers(subs, claimedAt)
    const skipped = subs.length - usersToRefresh.length

    yield { type: 'start', total: subs.length, skipped } as RefreshProgressEvent

    if (subs.length === 0) {
      yield { type: 'done', errors: [] } as RefreshProgressEvent
      return
    }

    const errors: ActivityError[] = []
    const events: RefreshProgressEvent[] = []
    let completed = 0

    // Start all fetches concurrently
    const promises = usersToRefresh.map(async (user, index) => {
      const { login } = user

      try {
        const { itemCount } = await refreshGithubUser(user, claimedAt)
        events.push({ type: 'success', login, index, itemCount })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to refresh feed'
        errors.push({ login, message })
        events.push({ type: 'error', login, index, message })
      } finally {
        completed += 1
      }
    })

    // Yield events as they complete
    while (completed < usersToRefresh.length) {
      await new Promise(resolve => setTimeout(resolve, 100))
      while (events.length > 0) {
        yield events.shift()!
      }
    }

    // Wait for all to complete and yield remaining events
    await Promise.all(promises)
    while (events.length > 0) {
      yield events.shift()!
    }

    yield { type: 'done', errors } as RefreshProgressEvent
  }),

  refreshOne: protectedProcedure.feed.refreshOne.handler(async ({ context, input }) => {
    const userId = context.session.user.id
    const login = normalizeLogin(input.params.login)

    // Verify the login is still in the user's synced GitHub following list
    const existingSub = await db
      .select({
        login: subscription.githubUserLogin,
        lastRefreshedAt: githubUser.lastRefreshedAt,
        refreshClaimedAt: githubUser.refreshClaimedAt,
      })
      .from(subscription)
      .innerJoin(githubUser, eq(subscription.githubUserLogin, githubUser.login))
      .where(and(eq(subscription.userId, userId), eq(subscription.githubUserLogin, login)))
      .limit(1)

    const existingSubRow = existingSub[0]
    if (!existingSubRow) {
      throw new ORPCError('NOT_FOUND', { message: 'User not in your GitHub following list' })
    }

    const claimedAt = new Date()
    const usersToRefresh = await claimRefreshableUsers([existingSubRow], claimedAt)
    if (usersToRefresh.length === 0) {
      return { skipped: true as const }
    }

    const { refreshedAt, itemCount } = await refreshGithubUser(existingSubRow, claimedAt)
    return {
      skipped: false as const,
      refreshedAt: refreshedAt.toISOString(),
      itemCount,
    }
  }),

  clear: protectedProcedure.feed.clear.handler(async ({ context }) => {
    const userId = context.session.user.id
    // Get all GitHub users synced from this user's following list
    const subs = await db
      .select({ githubUserLogin: subscription.githubUserLogin })
      .from(subscription)
      .where(eq(subscription.userId, userId))

    const githubUserLogins = subs.map(s => s.githubUserLogin)

    if (githubUserLogins.length > 0) {
      // Delete feed items for synced GitHub users
      await db.delete(feedItem).where(inArray(feedItem.githubUserLogin, githubUserLogins))

      // Reset lastRefreshedAt for these github users
      await db
        .update(githubUser)
        .set({ lastRefreshedAt: null })
        .where(inArray(githubUser.login, githubUserLogins))
    }

    return { ok: true }
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
  // Ignore cached GitHub users and orphaned relations that no active app user follows.
  const refreshCandidates = await db
    .select({
      login: githubUser.login,
      lastRefreshedAt: githubUser.lastRefreshedAt,
      refreshClaimedAt: githubUser.refreshClaimedAt,
    })
    .from(githubUser)
    .innerJoin(subscription, eq(githubUser.login, subscription.githubUserLogin))
    .innerJoin(appUser, eq(subscription.userId, appUser.id))
    .groupBy(githubUser.login)
    .orderBy(asc(githubUser.lastRefreshedAt))
    .limit(50)

  if (refreshCandidates.length === 0) {
    return []
  }

  const claimedAt = new Date()
  const usersToRefresh = await claimRefreshableUsers(refreshCandidates, claimedAt)
  const skipped = refreshCandidates.length - usersToRefresh.length
  let success = 0
  let failed = 0

  // Process feeds concurrently
  const promises = usersToRefresh.map(async user => {
    try {
      await refreshGithubUser(user, claimedAt)
      return { success: true }
    } catch {
      return { success: false }
    }
  })

  const promiseResults = await Promise.all(promises)
  for (const result of promiseResults) {
    if (result.success) {
      success++
    } else {
      failed++
    }
  }

  return [{ refreshed: usersToRefresh.length, skipped, success, failed }]
}
