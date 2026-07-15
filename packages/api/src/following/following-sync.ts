import type { Database } from '@better-github-feed/db'
import { account } from '@better-github-feed/db/schema/auth'
import { githubUser, subscription } from '@better-github-feed/db/schema/github'
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm'

const MAX_SNAPSHOT_CHUNKS = 16
const FOLLOWING_SYNC_CLAIM_TIMEOUT_MS = 10 * 60 * 1000
const D1_JSON_CHUNK_MAX_BYTES = 1_800_000
const textEncoder = new TextEncoder()

export type GithubFollowingUser = {
  id: string
  login: string
}

type FollowingSnapshotRow = {
  githubId: string
  login: string
  subscriptionId: string
  createdAt: number
}

function buildFollowingDiff(currentLogins: string[], following: GithubFollowingUser[]) {
  const current = new Set(currentLogins)
  const remote = new Set(following.map(user => user.login))

  return {
    toAdd: following.filter(user => !current.has(user.login)),
    toRemove: currentLogins.filter(login => !remote.has(login)),
  }
}

function serializeFollowingSnapshotChunks(
  rows: FollowingSnapshotRow[],
  maxBytes = D1_JSON_CHUNK_MAX_BYTES,
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 2) {
    throw new RangeError('Snapshot chunk size must fit a JSON array')
  }

  const chunks: string[] = []
  let currentRows: string[] = []
  let currentBytes = 2

  for (const row of rows) {
    const serializedRow = JSON.stringify(row)
    const rowBytes = textEncoder.encode(serializedRow).byteLength

    if (rowBytes + 2 > maxBytes) {
      throw new RangeError('Snapshot row exceeds the JSON chunk size')
    }

    const separatorBytes = currentRows.length > 0 ? 1 : 0
    if (currentBytes + separatorBytes + rowBytes > maxBytes) {
      chunks.push(`[${currentRows.join(',')}]`)
      currentRows = []
      currentBytes = 2
    }

    currentBytes += (currentRows.length > 0 ? 1 : 0) + rowBytes
    currentRows.push(serializedRow)
  }

  if (currentRows.length > 0) {
    chunks.push(`[${currentRows.join(',')}]`)
  }

  return chunks.length > 0 ? chunks : ['[]']
}

export class FollowingAuthorizationError extends Error {
  constructor() {
    super('Reconnect your GitHub account before syncing follows')
    this.name = 'FollowingAuthorizationError'
  }
}

export class FollowingSyncInProgressError extends Error {
  constructor() {
    super('GitHub Following Sync already in progress')
    this.name = 'FollowingSyncInProgressError'
  }
}

export class FollowingSnapshotTooLargeError extends Error {
  constructor() {
    super('GitHub Following is too large to sync')
    this.name = 'FollowingSnapshotTooLargeError'
  }
}

export class FollowingUnavailableError extends Error {
  readonly retryable: boolean

  constructor(message = 'GitHub Following is unavailable', retryable = true) {
    super(message)
    this.name = 'FollowingUnavailableError'
    this.retryable = retryable
  }
}

type FollowingSyncDependencies = {
  database: Database
  getAccessToken: (userId: string) => Promise<string>
  getFollowing: (accessToken: string) => Promise<GithubFollowingUser[]>
}

export function createFollowingSync({
  database,
  getAccessToken,
  getFollowing,
}: FollowingSyncDependencies) {
  async function getGithubAccount(userId: string) {
    const rows = await database
      .select({ id: account.id })
      .from(account)
      .where(and(eq(account.userId, userId), eq(account.providerId, 'github')))
      .limit(1)
    const githubAccount = rows[0]
    if (!githubAccount) {
      throw new FollowingAuthorizationError()
    }
    return githubAccount
  }

  async function claim(accountId: string, claimedAt: Date) {
    const claimCutoff = new Date(claimedAt.getTime() - FOLLOWING_SYNC_CLAIM_TIMEOUT_MS)
    const result = await database
      .update(account)
      .set({ followingSyncClaimedAt: claimedAt })
      .where(
        and(
          eq(account.id, accountId),
          or(
            isNull(account.followingSyncClaimedAt),
            lt(account.followingSyncClaimedAt, claimCutoff),
          ),
        ),
      )
    return result.meta.changes > 0
  }

  async function release(accountId: string, claimedAt: Date) {
    try {
      await database
        .update(account)
        .set({ followingSyncClaimedAt: null })
        .where(and(eq(account.id, accountId), eq(account.followingSyncClaimedAt, claimedAt)))
    } catch {
      // An unreleased claim expires and can be recovered by a later sync.
    }
  }

  async function replaceSnapshot(userId: string, following: GithubFollowingUser[]) {
    const currentRows = await database
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
    const snapshot = following.map(user => {
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
      throw new FollowingSnapshotTooLargeError()
    }

    const upsertGithubUsers = snapshotJsonChunks.map(snapshotJson =>
      database
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
        }),
    )
    const replaceSubscriptions = snapshotJsonChunks.map(snapshotJson =>
      database.insert(subscription).select(sql`
        select
          json_extract(value, '$.subscriptionId'),
          ${userId},
          json_extract(value, '$.login'),
          json_extract(value, '$.createdAt')
        from json_each(${snapshotJson})
      `),
    )
    const firstUpsert = upsertGithubUsers[0]
    if (!firstUpsert) {
      throw new Error('GitHub Following snapshot is missing')
    }

    await database.batch([
      firstUpsert,
      ...upsertGithubUsers.slice(1),
      database.delete(subscription).where(eq(subscription.userId, userId)),
      ...replaceSubscriptions,
    ])

    return { total: following.length, added: toAdd.length, removed: toRemove.length }
  }

  return {
    async sync(userId: string) {
      const githubAccount = await getGithubAccount(userId)
      const claimedAt = new Date()
      if (!(await claim(githubAccount.id, claimedAt))) {
        throw new FollowingSyncInProgressError()
      }

      try {
        const accessToken = await getAccessToken(userId)
        const following = await getFollowing(accessToken)
        return await replaceSnapshot(userId, following)
      } finally {
        await release(githubAccount.id, claimedAt)
      }
    },
  }
}
