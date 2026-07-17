import type { Database } from '@better-github-feed/db'
import { user as appUser } from '@better-github-feed/db/schema/auth'
import {
  activityChange,
  feedItem,
  githubUser,
  subscription,
} from '@better-github-feed/db/schema/github'
import type { BatchItem } from 'drizzle-orm/batch'
import { and, asc, eq, isNull, lt, or, sql } from 'drizzle-orm'

const REFRESH_COOLDOWN_MS = 5 * 60 * 1000
const REFRESH_CLAIM_TIMEOUT_MS = 10 * 60 * 1000
const REFRESH_WRITE_CHUNK_SIZE = 8
const INITIAL_REFRESH_LIMIT = 50
const D1_JSON_CHUNK_MAX_BYTES = 1_800_000
const textEncoder = new TextEncoder()

type ActivityItem = {
  id: string
  title: string
  link: string | null
  repo: string | null
  type: string
  publishedAtMs: number
  summary: string | null
  content: string | null
}

function shouldSkipRefresh(lastRefreshedAt: Date | null, refreshClaimedAt: Date | null, now: Date) {
  const wasRefreshedRecently =
    lastRefreshedAt !== null && lastRefreshedAt.getTime() >= now.getTime() - REFRESH_COOLDOWN_MS
  const isRefreshInProgress =
    refreshClaimedAt !== null &&
    refreshClaimedAt.getTime() >= now.getTime() - REFRESH_CLAIM_TIMEOUT_MS
  return wasRefreshedRecently || isRefreshInProgress
}

function chunkArray<T>(items: T[], size: number, serialize: (item: T) => unknown) {
  const chunks: T[][] = []
  let current: T[] = []
  let currentBytes = 2
  for (const item of items) {
    const itemBytes = textEncoder.encode(JSON.stringify(serialize(item))).byteLength
    if (itemBytes + 2 > D1_JSON_CHUNK_MAX_BYTES) {
      throw new RangeError('Atom Activity exceeds the D1 JSON chunk size')
    }
    const separatorBytes = current.length > 0 ? 1 : 0
    if (
      current.length >= size ||
      currentBytes + separatorBytes + itemBytes > D1_JSON_CHUNK_MAX_BYTES
    ) {
      chunks.push(current)
      current = []
      currentBytes = 2
    }
    currentBytes += (current.length > 0 ? 1 : 0) + itemBytes
    current.push(item)
  }
  if (current.length > 0) {
    chunks.push(current)
  }
  return chunks
}

function normalizeLogin(input: string) {
  return input.trim().replace(/^@/, '').toLowerCase()
}

export class FeedRefreshTargetNotFoundError extends Error {
  constructor() {
    super('GitHub account is not in your GitHub Following')
    this.name = 'FeedRefreshTargetNotFoundError'
  }
}

type RefreshCandidate = {
  login: string
  githubId: string | null
  lastRefreshedAt: Date | null
  refreshClaimedAt: Date | null
}

type FeedRefreshDependencies = {
  database: Database
  getActivity: (login: string) => Promise<{ items: ActivityItem[]; githubId: string | null }>
  now?: () => Date
}

export type FeedRefreshOutcome =
  | { type: 'start'; total: number; skipped: number }
  | { type: 'refreshed'; login: string; index: number; itemCount: number }
  | { type: 'failed'; login: string; index: number; message: string }
  | { type: 'done'; errors: Array<{ login: string; message: string }> }

export function createFeedRefresh({
  database,
  getActivity,
  now = () => new Date(),
}: FeedRefreshDependencies) {
  async function getFollowingCandidates(userId: string) {
    return database
      .select({
        login: subscription.githubUserLogin,
        githubId: githubUser.id,
        lastRefreshedAt: githubUser.lastRefreshedAt,
        refreshClaimedAt: githubUser.refreshClaimedAt,
      })
      .from(subscription)
      .innerJoin(githubUser, eq(subscription.githubUserLogin, githubUser.login))
      .where(eq(subscription.userId, userId))
  }

  async function claim(user: RefreshCandidate, claimedAt: Date) {
    if (shouldSkipRefresh(user.lastRefreshedAt, user.refreshClaimedAt, claimedAt)) {
      return false
    }
    const cooldownCutoff = new Date(claimedAt.getTime() - REFRESH_COOLDOWN_MS)
    const claimCutoff = new Date(claimedAt.getTime() - REFRESH_CLAIM_TIMEOUT_MS)
    const result = await database
      .update(githubUser)
      .set({ refreshClaimedAt: claimedAt })
      .where(
        and(
          eq(githubUser.login, user.login),
          or(isNull(githubUser.lastRefreshedAt), lt(githubUser.lastRefreshedAt, cooldownCutoff)),
          or(isNull(githubUser.refreshClaimedAt), lt(githubUser.refreshClaimedAt, claimCutoff)),
        ),
      )
    return result.meta.changes > 0
  }

  async function release(user: RefreshCandidate, claimedAt: Date) {
    try {
      await database
        .update(githubUser)
        .set({ refreshClaimedAt: null })
        .where(and(eq(githubUser.login, user.login), eq(githubUser.refreshClaimedAt, claimedAt)))
    } catch {
      // An unreleased claim expires and can be recovered by a later refresh.
    }
  }

  async function refresh(user: RefreshCandidate, claimedAt: Date) {
    try {
      const { items, githubId } = await getActivity(user.login)
      const resolvedGithubId = githubId ?? user.githubId
      const actorKey = resolvedGithubId
        ? `github:${resolvedGithubId}`
        : `legacy-atom-login:${user.login}`
      const rows = items.map(item => ({
        id: item.id,
        githubUserLogin: user.login,
        actorKey,
        actorGithubId: resolvedGithubId,
        source: 'github-atom-v1',
        title: item.title,
        link: item.link,
        repo: item.repo,
        type: item.type,
        summary: item.summary,
        content: item.content,
        publishedAt: new Date(item.publishedAtMs),
      }))

      const refreshedAt = now()
      const statements: BatchItem<'sqlite'>[] = []
      for (const rowsChunk of chunkArray(rows, REFRESH_WRITE_CHUNK_SIZE, row => ({
        ...row,
        publishedAt: row.publishedAt.getTime(),
      }))) {
        const rowsJson = JSON.stringify(
          rowsChunk.map(row => ({ ...row, publishedAt: row.publishedAt.getTime() })),
        )
        const changeRowsJson = JSON.stringify(
          rowsChunk.map(row => ({
            id: row.id,
            source: row.source,
            actorKey: row.actorKey,
            actorGithubId: row.actorGithubId,
          })),
        )
        statements.push(
          database
            .insert(feedItem)
            .select(sql`
              select
                json_extract(value, '$.id'),
                json_extract(value, '$.githubUserLogin'),
                json_extract(value, '$.actorKey'),
                json_extract(value, '$.actorGithubId'),
                json_extract(value, '$.source'),
                json_extract(value, '$.title'),
                json_extract(value, '$.link'),
                json_extract(value, '$.repo'),
                json_extract(value, '$.type'),
                json_extract(value, '$.summary'),
                json_extract(value, '$.content'),
                0,
                json_extract(value, '$.publishedAt'),
                ${refreshedAt.getTime()}
              from json_each(${rowsJson})
              where exists (
                select 1 from ${githubUser}
                where ${githubUser.login} = ${user.login}
                  and ${githubUser.refreshClaimedAt} = ${claimedAt.getTime()}
              )
            `)
            .onConflictDoNothing(),
          database
            .insert(activityChange)
            .select(sql`
              select
                null,
                json_extract(value, '$.source'),
                json_extract(value, '$.id'),
                json_extract(value, '$.actorKey'),
                json_extract(value, '$.actorGithubId'),
                ${refreshedAt.getTime()}
              from json_each(${changeRowsJson})
              where exists (
                select 1 from ${githubUser}
                where ${githubUser.login} = ${user.login}
                  and ${githubUser.refreshClaimedAt} = ${claimedAt.getTime()}
              )
                and not exists (
                  select 1 from ${activityChange}
                  where ${activityChange.source} = json_extract(value, '$.source')
                    and ${activityChange.activityId} = json_extract(value, '$.id')
                )
            `)
            .onConflictDoNothing(),
        )
      }
      statements.push(
        database
          .update(githubUser)
          .set({
            id: resolvedGithubId ?? undefined,
            lastRefreshedAt: refreshedAt,
            refreshClaimedAt: null,
          })
          .where(and(eq(githubUser.login, user.login), eq(githubUser.refreshClaimedAt, claimedAt))),
      )
      const results = await database.batch(
        statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]],
      )
      const result = results.at(-1) as { meta: { changes: number } } | undefined
      if (!result || result.meta.changes === 0) {
        throw new Error(`Feed Refresh for ${user.login} was superseded`)
      }

      return { refreshedAt, itemCount: items.length }
    } catch (error) {
      await release(user, claimedAt)
      throw error
    }
  }

  return {
    async refreshUninitializedFollowing(userId: string) {
      const users = await database
        .select({
          login: githubUser.login,
          githubId: githubUser.id,
          lastRefreshedAt: githubUser.lastRefreshedAt,
          refreshClaimedAt: githubUser.refreshClaimedAt,
        })
        .from(subscription)
        .innerJoin(githubUser, eq(subscription.githubUserLogin, githubUser.login))
        .where(and(eq(subscription.userId, userId), isNull(githubUser.lastRefreshedAt)))
        .orderBy(asc(githubUser.createdAt))
        .limit(INITIAL_REFRESH_LIMIT)
      const claimedAt = now()
      const claimedUsers: RefreshCandidate[] = []

      try {
        for (const user of users) {
          // Claims are serialized so earlier successes can be released if a later claim fails.
          // oxlint-disable-next-line react-doctor/async-await-in-loop
          if (await claim(user, claimedAt)) claimedUsers.push(user)
        }
      } catch (error) {
        await Promise.all(claimedUsers.map(user => release(user, claimedAt)))
        throw error
      }

      const results = await Promise.allSettled(claimedUsers.map(user => refresh(user, claimedAt)))
      const succeeded = results.filter(result => result.status === 'fulfilled').length
      return {
        attempted: claimedUsers.length,
        succeeded,
        failed: results.length - succeeded,
      }
    },

    async *refreshFollowing(userId: string): AsyncGenerator<FeedRefreshOutcome> {
      const users = await getFollowingCandidates(userId)
      const claimedAt = now()
      const claimedUsers: RefreshCandidate[] = []

      try {
        for (const user of users) {
          // Claims are serialized so earlier successes can be released if a later claim fails.
          // oxlint-disable-next-line react-doctor/async-await-in-loop
          if (await claim(user, claimedAt)) {
            claimedUsers.push(user)
          }
        }
      } catch (error) {
        await Promise.all(claimedUsers.map(user => release(user, claimedAt)))
        throw error
      }

      yield { type: 'start', total: users.length, skipped: users.length - claimedUsers.length }

      const pending = new Map<
        number,
        Promise<{
          index: number
          outcome: FeedRefreshOutcome
          error?: { login: string; message: string }
        }>
      >()
      for (const [index, user] of claimedUsers.entries()) {
        pending.set(
          index,
          refresh(user, claimedAt)
            .then(result => ({
              index,
              outcome: {
                type: 'refreshed' as const,
                login: user.login,
                index,
                itemCount: result.itemCount,
              },
            }))
            .catch((error: unknown) => {
              const message = error instanceof Error ? error.message : 'Feed Refresh failed'
              return {
                index,
                outcome: { type: 'failed' as const, login: user.login, index, message },
                error: { login: user.login, message },
              }
            }),
        )
      }

      const errors: Array<{ login: string; message: string }> = []
      while (pending.size > 0) {
        const result = await Promise.race(pending.values())
        pending.delete(result.index)
        if (result.error) {
          errors.push(result.error)
        }
        yield result.outcome
      }

      yield { type: 'done', errors }
    },

    async refreshAllActive() {
      const users = await database
        .select({
          login: githubUser.login,
          githubId: githubUser.id,
          lastRefreshedAt: githubUser.lastRefreshedAt,
          refreshClaimedAt: githubUser.refreshClaimedAt,
        })
        .from(githubUser)
        .innerJoin(subscription, eq(githubUser.login, subscription.githubUserLogin))
        .innerJoin(appUser, eq(subscription.userId, appUser.id))
        .groupBy(githubUser.login)
        .orderBy(asc(githubUser.lastRefreshedAt))
        .limit(50)
      if (users.length === 0) {
        return []
      }

      const claimedAt = now()
      const claimedUsers: RefreshCandidate[] = []
      try {
        for (const user of users) {
          // Claims are serialized so earlier successes can be released if a later claim fails.
          // oxlint-disable-next-line react-doctor/async-await-in-loop
          if (await claim(user, claimedAt)) {
            claimedUsers.push(user)
          }
        }
      } catch (error) {
        await Promise.all(claimedUsers.map(user => release(user, claimedAt)))
        throw error
      }

      const results = await Promise.allSettled(claimedUsers.map(user => refresh(user, claimedAt)))
      const success = results.filter(result => result.status === 'fulfilled').length
      const failed = results.length - success
      return [
        {
          refreshed: claimedUsers.length,
          skipped: users.length - claimedUsers.length,
          success,
          failed,
        },
      ]
    },

    async refreshOne(userId: string, inputLogin: string) {
      const login = normalizeLogin(inputLogin)
      const rows = await database
        .select({
          login: subscription.githubUserLogin,
          githubId: githubUser.id,
          lastRefreshedAt: githubUser.lastRefreshedAt,
          refreshClaimedAt: githubUser.refreshClaimedAt,
        })
        .from(subscription)
        .innerJoin(githubUser, eq(subscription.githubUserLogin, githubUser.login))
        .where(and(eq(subscription.userId, userId), eq(subscription.githubUserLogin, login)))
        .limit(1)
      const user = rows[0]
      if (!user) {
        throw new FeedRefreshTargetNotFoundError()
      }

      const claimedAt = now()
      if (!(await claim(user, claimedAt))) {
        return { skipped: true as const }
      }
      const result = await refresh(user, claimedAt)
      return { skipped: false as const, ...result }
    },
  }
}
