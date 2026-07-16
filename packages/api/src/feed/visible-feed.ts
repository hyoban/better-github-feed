import type { Database } from '@better-github-feed/db'
import {
  feedItem,
  githubUser,
  subscription,
  userFeedState,
  userFilter,
} from '@better-github-feed/db/schema/github'
import { and, desc, eq, gt, inArray, isNull, lt, not, or, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'

import { deserializeFilterGroup, filterRuleToDrizzleWhere } from '../filter/drizzle-transform'
import { createLocalFeedSync } from '../local-feed/local-feed-sync'

type VisibleFeedInput = {
  userId: string
  cursor?: string
  limit?: number
  users?: string[]
  types?: string[]
}

function encodeCursor(publishedAt: Date, id: string) {
  return `${publishedAt.getTime()}:${encodeURIComponent(id)}`
}

function decodeCursor(cursor: string) {
  const separator = cursor.indexOf(':')
  const publishedAtMs = Number(cursor.slice(0, separator))
  const encodedId = cursor.slice(separator + 1)
  if (
    separator < 1 ||
    !Number.isSafeInteger(publishedAtMs) ||
    Math.abs(publishedAtMs) > 8_640_000_000_000_000 ||
    encodedId.length === 0
  ) {
    throw new RangeError('Invalid Visible Feed cursor')
  }
  try {
    const id = decodeURIComponent(encodedId)
    if (id.length === 0 || encodeURIComponent(id) !== encodedId) {
      throw new RangeError('Invalid Visible Feed cursor')
    }
    return { publishedAt: new Date(publishedAtMs), id }
  } catch {
    throw new RangeError('Invalid Visible Feed cursor')
  }
}

function mapVisibleFeedItem(row: {
  id: string
  githubUserLogin: string
  title: string
  link: string | null
  repo: string | null
  type: string
  summary: string | null
  content: string | null
  publishedAt: Date
}) {
  const publishedAtMs = row.publishedAt.getTime()
  return {
    id: row.id,
    actor: row.githubUserLogin,
    title: row.title,
    link: row.link,
    repo: row.repo,
    type: row.type,
    publishedAt: row.publishedAt.toISOString(),
    publishedAtMs,
    summary: row.summary,
    content: row.content,
    source: row.githubUserLogin,
  }
}

async function getVisibleCondition(database: Database, userId: string): Promise<SQL | undefined> {
  const rows = await database
    .select()
    .from(userFilter)
    .where(and(eq(userFilter.userId, userId), isNull(userFilter.deletedAt)))
  const matches: SQL[] = []

  for (const row of rows) {
    try {
      const match = filterRuleToDrizzleWhere(deserializeFilterGroup(row.filterRule))
      if (match) {
        matches.push(match)
      }
    } catch {
      // Invalid persisted filters fail open so the feed remains available.
    }
  }

  const hiddenByUserFilter = matches.length > 0 ? or(...matches) : undefined
  return hiddenByUserFilter ? not(sql<boolean>`coalesce(${hiddenByUserFilter}, false)`) : undefined
}

function getBaseConditions(
  visibleCondition: SQL | undefined,
  activityClearedAt: Date | null,
): SQL[] {
  const conditions: SQL[] = [eq(feedItem.hidden, false)]
  if (activityClearedAt) {
    conditions.push(gt(feedItem.publishedAt, activityClearedAt))
  }
  if (visibleCondition) {
    conditions.push(visibleCondition)
  }
  return conditions
}

export function createVisibleFeed(database: Database) {
  async function getActivityClearedAt(userId: string) {
    const rows = await database
      .select({ activityClearedAt: userFeedState.activityClearedAt })
      .from(userFeedState)
      .where(eq(userFeedState.userId, userId))
      .limit(1)
    return rows[0]?.activityClearedAt ?? null
  }

  return {
    async list({ userId, cursor, limit = 20, users = [], types = [] }: VisibleFeedInput) {
      const [visibleCondition, activityClearedAt] = await Promise.all([
        getVisibleCondition(database, userId),
        getActivityClearedAt(userId),
      ])
      const conditions = getBaseConditions(visibleCondition, activityClearedAt)
      if (cursor) {
        const decodedCursor = decodeCursor(cursor)
        conditions.push(
          or(
            lt(feedItem.publishedAt, decodedCursor.publishedAt),
            and(
              eq(feedItem.publishedAt, decodedCursor.publishedAt),
              lt(feedItem.id, decodedCursor.id),
            ),
          )!,
        )
      }
      if (users.length > 0) {
        conditions.push(inArray(githubUser.login, users))
      }
      if (types.length > 0) {
        conditions.push(inArray(feedItem.type, types))
      }

      const rows = await database
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
        .where(and(...conditions))
        .orderBy(desc(feedItem.publishedAt), desc(feedItem.id))
        .limit(limit + 1)

      const hasMore = rows.length > limit
      const itemRows = hasMore ? rows.slice(0, limit) : rows
      const items = itemRows.map(row => mapVisibleFeedItem(row))
      const lastItem = items.at(-1)

      let availableTypes: string[] = []
      let typeCounts: Record<string, number> = {}
      if (!cursor) {
        const typeConditions = getBaseConditions(visibleCondition, activityClearedAt)
        if (users.length > 0) {
          typeConditions.push(inArray(githubUser.login, users))
        }

        const typeRows = await database
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
          .where(and(...typeConditions))
          .groupBy(feedItem.type)

        availableTypes = typeRows.map(row => row.type)
        typeCounts = Object.fromEntries(typeRows.map(row => [row.type, Number(row.count) || 0]))
      }

      return {
        items,
        nextCursor:
          hasMore && lastItem ? encodeCursor(new Date(lastItem.publishedAtMs), lastItem.id) : null,
        hasMore,
        types: availableTypes,
        typeCounts,
      }
    },

    async listFollowing(userId: string) {
      const [rows, visibleCondition, activityClearedAt] = await Promise.all([
        database
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
          .orderBy(desc(subscription.createdAt)),
        getVisibleCondition(database, userId),
        getActivityClearedAt(userId),
      ])
      const statsConditions = [
        eq(subscription.userId, userId),
        ...getBaseConditions(visibleCondition, activityClearedAt),
      ]

      const stats =
        rows.length > 0
          ? await database
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

      const statsByLogin = new Map(
        stats.map(row => [
          row.githubUserLogin,
          {
            itemCount: Number(row.count) || 0,
            latestEntryAt: row.latestEntryAt ? new Date(row.latestEntryAt) : null,
          },
        ]),
      )

      return rows.map(row => ({
        ...row,
        itemCount: statsByLogin.get(row.githubUserLogin)?.itemCount ?? 0,
        latestEntryAt: statsByLogin.get(row.githubUserLogin)?.latestEntryAt ?? null,
      }))
    },

    async clear(userId: string, clearedAt = new Date()) {
      await createLocalFeedSync({ database, now: () => clearedAt }).commitLegacyClear(userId)
      return { ok: true as const }
    },
  }
}
