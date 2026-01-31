import { db } from '@better-github-feed/db'
import {
  feedItem,
  githubUser,
  subscription,
  userFilter,
} from '@better-github-feed/db/schema/github'
import { ORPCError } from '@orpc/server'
import { and, desc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'

import { deserializeFilterGroup, filterRuleToDrizzleWhere } from '../filter/drizzle-transform'
import { protectedProcedure } from '../index'
import { chunkArray, normalizeLogin } from './utils'

const loginSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^@?[a-z0-9-]+$/i, 'Invalid GitHub username')

function extractGithubAtomLogins(source: string) {
  const matches: string[] = []
  const pattern = /https?:\/\/github\.com\/([A-Z0-9-]+)\.atom\b/gi

  for (const match of source.matchAll(pattern)) {
    if (match[1]) {
      matches.push(match[1])
    }
  }

  return matches
}

type SubscriptionRow = {
  id: string
  githubUserLogin: string
  githubUserId: string | null
  lastRefreshedAt: Date | null
  createdAt: Date
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

    // Get item counts and latest entry time for subscribed github users
    const githubUserLogins = rows.map(r => r.githubUserLogin)

    // Load user's filter rules and build conditions
    const userFilters = await db.select().from(userFilter).where(eq(userFilter.userId, userId))
    const filterConditions = []
    for (const uf of userFilters) {
      try {
        const rule = deserializeFilterGroup(uf.filterRule)
        const where = filterRuleToDrizzleWhere(rule)
        if (where)
          filterConditions.push(where)
      }
      catch {
        // Skip invalid rules
      }
    }

    // Build stats conditions including user filters
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
      stats.map(s => [
        s.githubUserLogin,
        {
          count: Number(s.count) || 0,
          latestEntryAt: s.latestEntryAt ? new Date(s.latestEntryAt) : null,
        },
      ]),
    )

    return rows.map(row => ({
      ...row,
      itemCount: statsMap.get(row.githubUserLogin)?.count ?? 0,
      latestEntryAt: statsMap.get(row.githubUserLogin)?.latestEntryAt ?? null,
    }))
  }),

  add: protectedProcedure.subscription.add.handler(async ({ context, input }) => {
    const userId = context.session.user.id
    const login = normalizeLogin(input.body.login)
    if (!login) {
      throw new ORPCError('BAD_REQUEST', {
        message: 'GitHub username is required',
      })
    }

    // Check if github user exists
    const existingGithubUser = await db
      .select({
        login: githubUser.login,
        id: githubUser.id,
        lastRefreshedAt: githubUser.lastRefreshedAt,
        createdAt: githubUser.createdAt,
      })
      .from(githubUser)
      .where(eq(githubUser.login, login))
      .limit(1)

    let githubUserRecord = existingGithubUser[0]

    // Create github user if it doesn't exist
    if (!githubUserRecord) {
      const createdAt = new Date()
      await db.insert(githubUser).values({
        login,
        createdAt,
      })
      githubUserRecord = {
        login,
        id: null,
        lastRefreshedAt: null,
        createdAt,
      }
    }

    // Check if subscription already exists
    const existingSub = await db
      .select({ id: subscription.id, createdAt: subscription.createdAt })
      .from(subscription)
      .where(and(eq(subscription.userId, userId), eq(subscription.githubUserLogin, login)))
      .limit(1)

    const existingSubRow = existingSub[0]
    if (existingSubRow) {
      throw new ORPCError('CONFLICT', {
        message: `@${login} is already in your list`,
      })
    }

    // Create subscription
    const subId = crypto.randomUUID()
    const subCreatedAt = new Date()
    await db.insert(subscription).values({
      id: subId,
      userId,
      githubUserLogin: login,
      createdAt: subCreatedAt,
    })

    return {
      id: subId,
      githubUserLogin: login,
      githubUserId: githubUserRecord.id,
      lastRefreshedAt: githubUserRecord.lastRefreshedAt,
      createdAt: subCreatedAt,
    } satisfies SubscriptionRow
  }),

  remove: protectedProcedure.subscription.remove.handler(async ({ context, input }) => {
    const userId = context.session.user.id
    await db
      .delete(subscription)
      .where(and(eq(subscription.id, input.params.id), eq(subscription.userId, userId)))

    return { ok: true }
  }),

  importOpml: protectedProcedure.subscription.importOpml.handler(async ({ context, input }) => {
    const userId = context.session.user.id
    const extracted = extractGithubAtomLogins(input.body.opml)
    const normalized: string[] = []
    const seen = new Set<string>()

    extracted.forEach((login) => {
      const normalizedLogin = normalizeLogin(login)
      if (!normalizedLogin) {
        return
      }
      if (!loginSchema.safeParse(normalizedLogin).success) {
        return
      }
      if (seen.has(normalizedLogin)) {
        return
      }
      seen.add(normalizedLogin)
      normalized.push(normalizedLogin)
    })

    if (normalized.length === 0) {
      return {
        total: 0,
        added: 0,
        skipped: 0,
        logins: [] as string[],
      }
    }

    // Get existing github users
    const existingGithubUsers = await db.select({ login: githubUser.login }).from(githubUser)

    const existingLoginSet = new Set(existingGithubUsers.map(u => u.login))
    const loginsToCreate = normalized.filter(login => !existingLoginSet.has(login))

    // Create github users for new logins
    const createdAt = new Date()
    for (const login of loginsToCreate) {
      await db.insert(githubUser).values({ login, createdAt }).onConflictDoNothing()
      existingLoginSet.add(login)
    }

    // Get existing subscriptions for this user
    const existingSubs = await db
      .select({ githubUserLogin: subscription.githubUserLogin })
      .from(subscription)
      .where(eq(subscription.userId, userId))

    const existingSubSet = new Set(existingSubs.map(s => s.githubUserLogin))
    const toInsert = normalized.filter((login) => {
      return existingLoginSet.has(login) && !existingSubSet.has(login)
    })

    if (toInsert.length > 0) {
      const subCreatedAt = new Date()
      const chunks = chunkArray(toInsert, 20)
      for (const chunk of chunks) {
        await db.insert(subscription).values(
          chunk.map(login => ({
            id: crypto.randomUUID(),
            userId,
            githubUserLogin: login,
            createdAt: subCreatedAt,
          })),
        )
      }
    }

    return {
      total: normalized.length,
      added: toInsert.length,
      skipped: normalized.length - toInsert.length,
      logins: toInsert,
    }
  }),

  exportOpml: protectedProcedure.subscription.exportOpml.handler(async ({ context }) => {
    const userId = context.session.user.id
    const rows = await db
      .select({ githubUserLogin: subscription.githubUserLogin })
      .from(subscription)
      .where(eq(subscription.userId, userId))
      .orderBy(subscription.githubUserLogin)

    const outlines = rows
      .map(
        row =>
          `    <outline text="${row.githubUserLogin}" title="${row.githubUserLogin}" type="rss" xmlUrl="https://github.com/${row.githubUserLogin}.atom" htmlUrl="https://github.com/${row.githubUserLogin}" />`,
      )
      .join('\n')

    const opml = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>Better GitHub Feed Subscriptions</title>
  </head>
  <body>
${outlines}
  </body>
</opml>`

    return { opml }
  }),
}
