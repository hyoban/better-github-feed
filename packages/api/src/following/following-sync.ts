import type { Database } from '@better-github-feed/db'
import { account } from '@better-github-feed/db/schema/auth'
import {
  followingMember,
  followingSnapshot,
  followingSyncState,
  githubUser,
  subscription,
} from '@better-github-feed/db/schema/github'
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
  actorKey: string
  githubId: string
  login: string
  legacyActorKeys: string[]
  position: number
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
  constructor(
    message = 'GitHub Following is unavailable',
    readonly retryable = true,
    readonly rateLimited = false,
    readonly retryAt?: number,
  ) {
    super(message)
    this.name = 'FollowingUnavailableError'
  }
}

type FollowingSyncDependencies = {
  database: Database
  getAccessToken: (userId: string, githubAccountId: string) => Promise<string>
  getFollowing: (accessToken: string) => Promise<GithubFollowingUser[]>
  now?: () => Date
}

export function createFollowingSync({
  database,
  getAccessToken,
  getFollowing,
  now = () => new Date(),
}: FollowingSyncDependencies) {
  async function getGithubAccount(userId: string) {
    const rows = await database
      .select({ id: account.id, accountId: account.accountId })
      .from(account)
      .where(and(eq(account.userId, userId), eq(account.providerId, 'github')))
      .limit(2)
    const githubAccount = rows[0]
    if (rows.length !== 1 || !githubAccount || !/^[1-9]\d*$/.test(githubAccount.accountId)) {
      throw new FollowingAuthorizationError()
    }
    return githubAccount
  }

  async function release(
    userId: string,
    githubAccountId: string,
    claimToken: string,
    claimedAt: Date,
  ) {
    try {
      await database.batch([
        database
          .update(followingSyncState)
          .set({ claimToken: null, claimClaimedAt: null })
          .where(
            and(
              eq(followingSyncState.userId, userId),
              eq(followingSyncState.claimToken, claimToken),
            ),
          ),
        database
          .update(account)
          .set({ followingSyncClaimedAt: null })
          .where(
            and(eq(account.id, githubAccountId), eq(account.followingSyncClaimedAt, claimedAt)),
          ),
      ])
    } catch {
      // Unreleased claims expire and can be recovered by a later sync.
    }
  }

  async function claim(
    userId: string,
    githubAccountId: string,
    claimToken: string,
    claimedAt: Date,
  ) {
    const claimCutoff = new Date(claimedAt.getTime() - FOLLOWING_SYNC_CLAIM_TIMEOUT_MS)
    const [, stateClaim, legacyClaim] = await database.batch([
      database.insert(followingSyncState).values({ userId }).onConflictDoNothing(),
      database
        .update(followingSyncState)
        .set({ claimToken, claimClaimedAt: claimedAt })
        .where(
          and(
            eq(followingSyncState.userId, userId),
            or(
              isNull(followingSyncState.claimClaimedAt),
              lt(followingSyncState.claimClaimedAt, claimCutoff),
            ),
            sql`exists (
              select 1 from ${account}
              where ${account.id} = ${githubAccountId}
                and (
                  ${account.followingSyncClaimedAt} is null
                  or ${account.followingSyncClaimedAt} < ${claimCutoff.getTime()}
                )
            )`,
          ),
        ),
      database
        .update(account)
        .set({ followingSyncClaimedAt: claimedAt })
        .where(
          and(
            eq(account.id, githubAccountId),
            or(
              isNull(account.followingSyncClaimedAt),
              lt(account.followingSyncClaimedAt, claimCutoff),
            ),
            sql`exists (
              select 1 from ${followingSyncState}
              where ${followingSyncState.userId} = ${userId}
                and ${followingSyncState.claimToken} = ${claimToken}
                and ${followingSyncState.claimClaimedAt} = ${claimedAt.getTime()}
            )`,
          ),
        ),
    ])
    if (stateClaim.meta.changes > 0 && legacyClaim.meta.changes > 0) return true
    try {
      if (stateClaim.meta.changes > 0) {
        await database
          .update(followingSyncState)
          .set({ claimToken: null, claimClaimedAt: null })
          .where(
            and(
              eq(followingSyncState.userId, userId),
              eq(followingSyncState.claimToken, claimToken),
            ),
          )
      }
      if (legacyClaim.meta.changes > 0) {
        await database
          .update(account)
          .set({ followingSyncClaimedAt: null })
          .where(
            and(eq(account.id, githubAccountId), eq(account.followingSyncClaimedAt, claimedAt)),
          )
      }
    } catch {
      // Any fence actually acquired by this attempt expires if cleanup fails.
    }
    return false
  }

  async function markUnclaimedReauthenticationRequired(userId: string, failedAt: Date) {
    try {
      await database.insert(followingSyncState).values({ userId }).onConflictDoNothing()
      await database
        .update(followingSyncState)
        .set({
          reauthRequiredAt: sql`coalesce(
            ${followingSyncState.reauthRequiredAt},
            ${failedAt.getTime()}
          )`,
        })
        .where(and(eq(followingSyncState.userId, userId), isNull(followingSyncState.claimToken)))
    } catch {
      // The authorization error remains authoritative if its status cannot be persisted.
    }
  }

  async function markReauthenticationRequired(
    userId: string,
    githubAccountId: string,
    claimToken: string,
    claimedAt: Date,
    failedAt: Date,
  ) {
    await database
      .update(followingSyncState)
      .set({
        reauthRequiredAt: sql`coalesce(
          ${followingSyncState.reauthRequiredAt},
          ${failedAt.getTime()}
        )`,
      })
      .where(
        and(
          eq(followingSyncState.userId, userId),
          eq(followingSyncState.claimToken, claimToken),
          sql`exists (
            select 1 from ${account}
            where ${account.id} = ${githubAccountId}
              and ${account.followingSyncClaimedAt} = ${claimedAt.getTime()}
          )`,
        ),
      )
  }

  async function replaceSnapshot(
    userId: string,
    following: GithubFollowingUser[],
    claimToken: string,
    githubAccountId: string,
    claimedAt: Date,
  ) {
    const followingGithubIdsJson = JSON.stringify([...new Set(following.map(user => user.id))])
    const [currentRows, knownGithubUsers] = await Promise.all([
      database
        .select({
          id: subscription.id,
          githubUserLogin: subscription.githubUserLogin,
          createdAt: subscription.createdAt,
        })
        .from(subscription)
        .where(eq(subscription.userId, userId)),
      following.length === 0
        ? Promise.resolve([])
        : database.select({ id: githubUser.id, login: githubUser.login }).from(githubUser)
            .where(sql`
              ${githubUser.id} in (
                select value from json_each(${followingGithubIdsJson})
              )
            `),
    ])
    const { toAdd, toRemove } = buildFollowingDiff(
      currentRows.map(row => row.githubUserLogin),
      following,
    )

    const completedAt = now()
    const completedAtMs = completedAt.getTime()
    const revision = crypto.randomUUID()
    const knownLoginsByGithubId = new Map<string, Set<string>>()
    for (const knownUser of knownGithubUsers) {
      if (knownUser.id) {
        const logins = knownLoginsByGithubId.get(knownUser.id) ?? new Set<string>()
        logins.add(knownUser.login.toLowerCase())
        knownLoginsByGithubId.set(knownUser.id, logins)
      }
    }
    const snapshot = following
      .map(user => {
        const legacyLogins = knownLoginsByGithubId.get(user.id) ?? new Set<string>()
        legacyLogins.add(user.login.toLowerCase())
        return {
          actorKey: `github:${user.id}`,
          githubId: user.id,
          login: user.login,
          legacyActorKeys: [...legacyLogins].sort().map(login => `legacy-atom-login:${login}`),
        }
      })
      .sort((left, right) => left.actorKey.localeCompare(right.actorKey))
      .map((member, position) => ({ ...member, position }))
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
            ${completedAtMs} as created_at
          from json_each(${snapshotJson})
          where exists (
            select 1 from ${followingSyncState}
            where ${followingSyncState.userId} = ${userId}
              and ${followingSyncState.activeRevision} = ${revision}
          )
        `)
        .onConflictDoUpdate({
          target: githubUser.login,
          set: { id: sql`excluded.id` },
        }),
    )
    const insertMembers = snapshotJsonChunks.map(snapshotJson =>
      database.insert(followingMember).select(sql`
        select
          ${revision},
          json_extract(value, '$.actorKey'),
          json_extract(value, '$.githubId'),
          json_extract(value, '$.login'),
          json_extract(value, '$.legacyActorKeys'),
          json_extract(value, '$.position')
        from json_each(${snapshotJson})
      `),
    )
    await database.batch([
      database.insert(followingSnapshot).values({
        revision,
        userId,
        createdAt: completedAt,
        completedAt,
      }),
      ...insertMembers,
    ])

    await database.batch([
      database
        .update(followingSyncState)
        .set({
          previousRevision: sql`${followingSyncState.activeRevision}`,
          activeRevision: revision,
          completedAt,
          reauthRequiredAt: null,
          claimToken: null,
          claimClaimedAt: null,
        })
        .where(
          and(
            eq(followingSyncState.userId, userId),
            eq(followingSyncState.claimToken, claimToken),
            sql`exists (
              select 1 from ${account}
              where ${account.id} = ${githubAccountId}
                and ${account.followingSyncClaimedAt} = ${claimedAt.getTime()}
            )`,
          ),
        ),
      ...upsertGithubUsers,
      database.delete(subscription).where(
        and(
          eq(subscription.userId, userId),
          sql`exists (
            select 1 from ${followingSyncState}
            where ${followingSyncState.userId} = ${userId}
              and ${followingSyncState.activeRevision} = ${revision}
          )`,
          sql`not exists (
            select 1 from ${followingMember}
            where ${followingMember.revision} = ${revision}
              and ${followingMember.login} = ${subscription.githubUserLogin}
          )`,
        ),
      ),
      database.insert(subscription).select(sql`
        select
          ${revision} || ':' || ${followingMember.actorKey},
          ${userId},
          ${followingMember.login},
          ${completedAtMs}
        from ${followingMember}
        inner join ${followingSyncState}
          on ${followingSyncState.userId} = ${userId}
          and ${followingSyncState.activeRevision} = ${followingMember.revision}
        where ${followingMember.revision} = ${revision}
          and not exists (
            select 1 from ${subscription}
            where ${subscription.userId} = ${userId}
              and ${subscription.githubUserLogin} = ${followingMember.login}
          )
      `),
      database.delete(followingMember).where(sql`exists (
        select 1
        from ${followingSnapshot}
        inner join ${followingSyncState}
          on ${followingSyncState.userId} = ${userId}
          and ${followingSyncState.activeRevision} = ${revision}
        where ${followingSnapshot.revision} = ${followingMember.revision}
          and ${followingSnapshot.userId} = ${userId}
          and ${followingSnapshot.revision} <> ${followingSyncState.activeRevision}
          and (
            ${followingSyncState.previousRevision} is null
            or ${followingSnapshot.revision} <> ${followingSyncState.previousRevision}
          )
      )`),
      database.delete(followingSnapshot).where(sql`
        ${followingSnapshot.userId} = ${userId}
        and exists (
          select 1
          from ${followingSyncState}
          where ${followingSyncState.userId} = ${userId}
            and ${followingSyncState.activeRevision} = ${revision}
            and ${followingSnapshot.revision} <> ${followingSyncState.activeRevision}
            and (
              ${followingSyncState.previousRevision} is null
              or ${followingSnapshot.revision} <> ${followingSyncState.previousRevision}
            )
        )
      `),
    ])

    const activeRows = await database
      .select({ activeRevision: followingSyncState.activeRevision })
      .from(followingSyncState)
      .where(eq(followingSyncState.userId, userId))
      .limit(1)
    if (activeRows[0]?.activeRevision !== revision) {
      throw new Error('Following Sync was superseded')
    }

    return { total: following.length, added: toAdd.length, removed: toRemove.length }
  }

  return {
    async sync(userId: string) {
      const claimedAt = now()
      const claimToken = crypto.randomUUID()
      let githubAccount: Awaited<ReturnType<typeof getGithubAccount>>
      try {
        githubAccount = await getGithubAccount(userId)
      } catch (error) {
        if (error instanceof FollowingAuthorizationError) {
          await markUnclaimedReauthenticationRequired(userId, claimedAt)
        }
        throw error
      }
      if (!(await claim(userId, githubAccount.id, claimToken, claimedAt))) {
        throw new FollowingSyncInProgressError()
      }

      try {
        const accessToken = await getAccessToken(userId, githubAccount.accountId)
        const following = await getFollowing(accessToken)
        return await replaceSnapshot(userId, following, claimToken, githubAccount.id, claimedAt)
      } catch (error) {
        if (error instanceof FollowingAuthorizationError) {
          await markReauthenticationRequired(userId, githubAccount.id, claimToken, claimedAt, now())
        }
        throw error
      } finally {
        await release(userId, githubAccount.id, claimToken, claimedAt)
      }
    },
  }
}
