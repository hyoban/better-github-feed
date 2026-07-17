import type { Database } from '@better-github-feed/db'
import { account } from '@better-github-feed/db/schema/auth'
import {
  activityChange,
  activityRetentionState,
  activitySyncState,
  feedItem,
  followingMember,
  followingSnapshot,
  followingSyncState,
  userFeedState,
  userFilter,
  userMutationReceipt,
  userStateChange,
  userStateSyncState,
} from '@better-github-feed/db/schema/github'
import type { FilterGroup } from '@better-github-feed/shared'
import { filterGroupSchema } from '@better-github-feed/shared'
import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm'

import { deserializeFilterGroup, serializeFilterGroup } from '../filter/drizzle-transform'
import { getLocalFeedDataEpoch } from '../feed/activity-rollout'

export class LocalFeedAuthorizationError extends Error {
  constructor() {
    super('A GitHub account is required for Local Feed Sync')
    this.name = 'LocalFeedAuthorizationError'
  }
}

export class LocalFeedCursorError extends Error {
  constructor() {
    super('Invalid Local Feed Sync cursor')
    this.name = 'LocalFeedCursorError'
  }
}

export class FollowingSnapshotExpiredError extends Error {
  constructor() {
    super('The Following snapshot is not available')
    this.name = 'FollowingSnapshotExpiredError'
  }
}

export class ActivityScopeNotAuthorizedError extends Error {
  constructor() {
    super('The requested Activity scope is not in the active GitHub Following snapshot')
    this.name = 'ActivityScopeNotAuthorizedError'
  }
}

export class ActivityRetentionChangedError extends Error {
  constructor() {
    super('The retained Activity window changed while paging')
    this.name = 'ActivityRetentionChangedError'
  }
}

type FollowingCursor = {
  protocol: 1
  serverEpoch: string
  kind: 'following'
  userId: string
  revision: string
  position: number
}

type ActivityHistoryCursor = {
  protocol: 1
  serverEpoch: string
  kind: 'activity-history'
  userId: string
  scopeKey: string
  throughSeq: string
  retentionFingerprint: string
  publishedAtMs: number
  activityId: string
}

type ActivityDeltaCursor = {
  protocol: 1
  serverEpoch: string
  kind: 'activity-delta'
  userId: string
  scopeKey: string
  fromSeq: string
  throughSeq: string
  retentionFingerprint: string
  lastSeq: string
  lastActivityId: string
}

type UserStateSnapshotCursor = {
  protocol: 1
  serverEpoch: string
  kind: 'user-state-snapshot'
  userId: string
  epoch: string
  targetRevision: string
  position: string
}

type SyncCursor =
  | FollowingCursor
  | ActivityHistoryCursor
  | ActivityDeltaCursor
  | UserStateSnapshotCursor

type ActivityScope =
  | { kind: 'following'; followingRevision: string }
  | { kind: 'actors'; actorKeys: readonly [string, ...string[]] }

export type LocalFeedUserMutation =
  | {
      kind: 'filter.put'
      mutationId: string
      attemptId: string
      baseVersion: number
      filter: { id: string; name: string; filterRule: FilterGroup }
    }
  | {
      kind: 'filter.delete'
      mutationId: string
      attemptId: string
      baseVersion: number
      id: string
    }
  | {
      kind: 'feed.clear'
      mutationId: string
      attemptId: string
      baseVersion: number
      candidate: number
      timeAnchor?: string
    }

type FilterReplica = {
  id: string
  name: string
  filterRule: unknown
  version: number
  changedRevision: string
  createdAt: number
  updatedAt: number
  deletedAt: number | null
}

type FeedStateReplica = {
  activityClearedAt: number
  version: number
  changedRevision: string
}

function encodeBase64Url(bytes: Uint8Array) {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte)
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function decodeBase64Url(value: string) {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='))
  return Uint8Array.from(binary, character => character.codePointAt(0) ?? 0)
}

type LocalFeedSyncDependencies = {
  database: Database
  now?: () => Date
  serverEpoch?: string
  timeAnchorSecret?: string
}

export function createLocalFeedSync({
  database,
  now = () => new Date(),
  serverEpoch: serverEpochOverride,
  timeAnchorSecret = 'local-feed-v1-development-secret',
}: LocalFeedSyncDependencies) {
  function createHmacKey(domain: string) {
    return crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(`${timeAnchorSecret}\0${domain}`),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify'],
    )
  }

  const resolveServerEpoch = () => getLocalFeedDataEpoch(database, serverEpochOverride)

  async function encodeCursor(cursor: SyncCursor, serverEpoch: string) {
    const payload = encodeBase64Url(new TextEncoder().encode(JSON.stringify(cursor)))
    const signature = await crypto.subtle.sign(
      'HMAC',
      await createHmacKey(`local-feed/cursor/${serverEpoch}`),
      new TextEncoder().encode(payload),
    )
    return `${payload}.${encodeBase64Url(new Uint8Array(signature))}`
  }

  async function decodeCursor(cursor: string, serverEpoch: string): Promise<SyncCursor> {
    try {
      const separator = cursor.lastIndexOf('.')
      if (separator <= 0 || separator === cursor.length - 1) {
        throw new LocalFeedCursorError()
      }
      const payload = cursor.slice(0, separator)
      const signature = cursor.slice(separator + 1)
      const valid = await crypto.subtle.verify(
        'HMAC',
        await createHmacKey(`local-feed/cursor/${serverEpoch}`),
        decodeBase64Url(signature),
        new TextEncoder().encode(payload),
      )
      if (!valid) {
        throw new LocalFeedCursorError()
      }
      const decoded: unknown = JSON.parse(new TextDecoder().decode(decodeBase64Url(payload)))
      if (
        typeof decoded !== 'object' ||
        decoded === null ||
        !('kind' in decoded) ||
        !['following', 'activity-history', 'activity-delta', 'user-state-snapshot'].includes(
          String(decoded.kind),
        ) ||
        !('protocol' in decoded) ||
        decoded.protocol !== 1 ||
        !('serverEpoch' in decoded) ||
        decoded.serverEpoch !== serverEpoch ||
        !('userId' in decoded) ||
        typeof decoded.userId !== 'string'
      ) {
        throw new LocalFeedCursorError()
      }
      return decoded as SyncCursor
    } catch (error) {
      if (error instanceof LocalFeedCursorError) {
        throw error
      }
      throw new LocalFeedCursorError()
    }
  }

  async function createTimeAnchor(viewerGithubId: string, serverTime: number, serverEpoch: string) {
    const payload = `${viewerGithubId}:${serverEpoch}:${serverTime}`
    const signature = await crypto.subtle.sign(
      'HMAC',
      await createHmacKey(`local-feed/time-anchor/${serverEpoch}`),
      new TextEncoder().encode(payload),
    )
    return `${payload}.${encodeBase64Url(new Uint8Array(signature))}`
  }

  async function readTimeAnchor(viewerGithubId: string, serverEpoch: string, value?: string) {
    if (!value) {
      return null
    }
    const separator = value.lastIndexOf('.')
    if (separator <= 0) {
      return null
    }
    const payload = value.slice(0, separator)
    const signature = value.slice(separator + 1)
    const prefix = `${viewerGithubId}:${serverEpoch}:`
    if (!payload.startsWith(prefix)) {
      return null
    }
    try {
      const valid = await crypto.subtle.verify(
        'HMAC',
        await createHmacKey(`local-feed/time-anchor/${serverEpoch}`),
        decodeBase64Url(signature),
        new TextEncoder().encode(payload),
      )
      const serverTime = Number(payload.slice(prefix.length))
      return valid && Number.isSafeInteger(serverTime) ? serverTime : null
    } catch {
      return null
    }
  }
  async function getViewerGithubId(userId: string) {
    const rows = await database
      .select({ githubId: account.accountId })
      .from(account)
      .where(and(eq(account.userId, userId), eq(account.providerId, 'github')))
      .limit(2)
    const githubId = rows.length === 1 ? rows[0]?.githubId : null
    if (!githubId || !/^[1-9]\d*$/.test(githubId)) {
      throw new LocalFeedAuthorizationError()
    }
    return githubId
  }

  async function digest(value: string) {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
    return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('')
  }

  async function getActivityHead() {
    const rows = await database
      .select({ headSeq: sql<string>`cast(${activitySyncState.headSeq} as text)` })
      .from(activitySyncState)
      .where(eq(activitySyncState.id, 1))
      .limit(1)
    return rows[0]?.headSeq ?? '0'
  }

  function assertSequence(sequence: unknown): string {
    if (typeof sequence !== 'string' || !/^(0|[1-9]\d*)$/.test(sequence)) {
      throw new LocalFeedCursorError()
    }
    return sequence
  }

  async function encodeUserStateSnapshotCursor(input: {
    userId: string
    epoch: string
    targetRevision: string
    position: string
    serverEpoch: string
  }) {
    return encodeCursor(
      {
        protocol: 1,
        serverEpoch: input.serverEpoch,
        kind: 'user-state-snapshot',
        userId: input.userId,
        epoch: input.epoch,
        targetRevision: assertSequence(input.targetRevision),
        position: assertSequence(input.position),
      },
      input.serverEpoch,
    )
  }

  async function resolveThroughSeq(targetThroughSeq?: string) {
    const headSeq = await getActivityHead()
    const throughSeq = targetThroughSeq ? assertSequence(targetThroughSeq) : headSeq
    if (BigInt(throughSeq) > BigInt(headSeq)) {
      throw new LocalFeedCursorError()
    }
    return throughSeq
  }

  async function resolveActivityScope(userId: string, scope: ActivityScope) {
    const rows =
      scope.kind === 'following'
        ? await database
            .select({
              revision: followingSnapshot.revision,
              actorKey: followingMember.actorKey,
              legacyActorKeys: followingMember.legacyActorKeys,
            })
            .from(followingSnapshot)
            .leftJoin(followingMember, eq(followingMember.revision, followingSnapshot.revision))
            .where(
              and(
                eq(followingSnapshot.userId, userId),
                eq(followingSnapshot.revision, scope.followingRevision),
              ),
            )
        : await database
            .select({
              revision: followingSnapshot.revision,
              actorKey: followingMember.actorKey,
              legacyActorKeys: followingMember.legacyActorKeys,
            })
            .from(followingSyncState)
            .innerJoin(
              followingSnapshot,
              and(
                eq(followingSnapshot.userId, followingSyncState.userId),
                eq(followingSnapshot.revision, followingSyncState.activeRevision),
              ),
            )
            .leftJoin(followingMember, eq(followingMember.revision, followingSnapshot.revision))
            .where(eq(followingSyncState.userId, userId))
    const revision = rows[0]?.revision
    if (!revision) {
      throw new FollowingSnapshotExpiredError()
    }
    const memberGroups = rows.flatMap(member =>
      member.actorKey && member.legacyActorKeys
        ? [[member.actorKey, ...(JSON.parse(member.legacyActorKeys) as string[])]]
        : [],
    )
    const requestedActorKeys =
      scope.kind === 'actors' ? [...new Set(scope.actorKeys)].sort() : undefined
    let actorKeys: string[]
    if (scope.kind === 'following') {
      actorKeys = memberGroups.flat()
    } else {
      if (scope.actorKeys.length > 250) {
        throw new LocalFeedCursorError()
      }
      const requested = new Set(requestedActorKeys)
      const authorized = new Set(memberGroups.flat())
      if ([...requested].some(actorKey => !authorized.has(actorKey))) {
        throw new ActivityScopeNotAuthorizedError()
      }
      actorKeys = memberGroups
        .filter(group => group.some(actorKey => requested.has(actorKey)))
        .flat()
    }
    actorKeys = [...new Set(actorKeys)].sort()
    const scopeKey = await digest(
      JSON.stringify(
        scope.kind === 'following'
          ? { protocol: 1, revision, actorKeys: 'following' }
          : { protocol: 1, actorKeys: requestedActorKeys },
      ),
    )
    return { actorKeys, revision, scopeKey }
  }

  async function getRetentionFacts(actorKeys: string[]) {
    const rows =
      actorKeys.length === 0
        ? []
        : await database
            .select({
              actorKey: activityRetentionState.actorKey,
              compactedThroughSeq: sql<string>`cast(${activityRetentionState.compactedThroughSeq} as text)`,
              retentionGeneration: sql<string>`cast(${activityRetentionState.retentionGeneration} as text)`,
            })
            .from(activityRetentionState).where(sql`
              ${activityRetentionState.actorKey}
              in (select value from json_each(${JSON.stringify(actorKeys)}))
            `)
    const rowByActor = new Map(rows.map(row => [row.actorKey, row]))
    const normalized = actorKeys.map(actorKey => ({
      actorKey,
      compactedThroughSeq: rowByActor.get(actorKey)?.compactedThroughSeq ?? '0',
      retentionGeneration: rowByActor.get(actorKey)?.retentionGeneration ?? '0',
    }))
    return {
      actors: normalized,
      fingerprint: await digest(
        normalized.map(row => `${row.actorKey}:${row.retentionGeneration}`).join('\n'),
      ),
    }
  }

  function toRawActivity(row: {
    id: string
    source: string
    actorKey: string
    actorGithubId: string | null
    actorLogin: string
    title: string
    link: string | null
    repo: string | null
    type: string
    publishedAt: Date
    summary: string | null
    content: string | null
  }) {
    return {
      id: row.id,
      source: 'github-atom-v1' as const,
      actorKey: row.actorKey,
      actorGithubId: row.actorGithubId,
      actorLogin: row.actorLogin,
      title: row.title,
      link: row.link,
      repo: row.repo,
      type: row.type,
      publishedAt: row.publishedAt.toISOString(),
      publishedAtMs: row.publishedAt.getTime(),
      summary: row.summary,
      content: row.content,
    }
  }

  const activitySelection = {
    id: feedItem.id,
    source: feedItem.source,
    actorKey: feedItem.actorKey,
    actorGithubId: feedItem.actorGithubId,
    actorLogin: feedItem.githubUserLogin,
    title: feedItem.title,
    link: feedItem.link,
    repo: feedItem.repo,
    type: feedItem.type,
    publishedAt: feedItem.publishedAt,
    summary: feedItem.summary,
    content: feedItem.content,
  }

  async function ensureUserState(userId: string, serverEpoch: string) {
    const read = () =>
      database
        .select({
          revision: sql<string>`cast(${userStateSyncState.headSeq} as text)`,
          compactedThroughSeq: sql<string>`cast(${userStateSyncState.compactedThroughSeq} as text)`,
          epoch: userStateSyncState.epoch,
        })
        .from(userStateSyncState)
        .where(eq(userStateSyncState.userId, userId))
        .limit(1)
    const existing = await read()
    if (existing[0]) {
      const expectedEpoch = `${serverEpoch}:${userId}`
      if (existing[0].epoch !== expectedEpoch) {
        await database
          .update(userStateSyncState)
          .set({ epoch: expectedEpoch })
          .where(eq(userStateSyncState.userId, userId))
        return { ...existing[0], epoch: expectedEpoch }
      }
      return existing[0]
    }
    await database
      .insert(userStateSyncState)
      .values({ userId, epoch: `${serverEpoch}:${userId}` })
      .onConflictDoNothing()
    const inserted = await read()
    return (
      inserted[0] ?? {
        revision: '0',
        compactedThroughSeq: '0',
        epoch: `${serverEpoch}:${userId}`,
      }
    )
  }

  function normalizeStoredFilterRule(value: unknown) {
    try {
      return deserializeFilterGroup(JSON.stringify(value))
    } catch {
      return value
    }
  }

  function parseStoredFilterRule(value: string) {
    return normalizeStoredFilterRule(parseStoredFilterRuleForWire(value))
  }

  function parseStoredFilterRuleForWire(value: string) {
    try {
      return JSON.parse(value) as unknown
    } catch {
      return value
    }
  }

  function parseFilterReplica(value: string) {
    const parsed = JSON.parse(value) as Omit<FilterReplica, 'filterRule'> & { filterRule: unknown }
    return {
      ...parsed,
      filterRule: normalizeStoredFilterRule(parsed.filterRule),
    }
  }

  async function getFilterReplica(userId: string, id: string): Promise<FilterReplica | null> {
    const rows = await database
      .select({
        id: userFilter.id,
        name: userFilter.name,
        filterRule: userFilter.filterRule,
        version: userFilter.entityVersion,
        changedRevision: sql<string>`cast(${userFilter.changedRevision} as text)`,
        createdAt: userFilter.createdAt,
        updatedAt: userFilter.updatedAt,
        deletedAt: userFilter.deletedAt,
      })
      .from(userFilter)
      .where(and(eq(userFilter.userId, userId), eq(userFilter.id, id)))
      .limit(1)
    const row = rows[0]
    if (!row) {
      return null
    }
    return {
      id: row.id,
      name: row.name,
      filterRule: parseStoredFilterRule(row.filterRule),
      version: row.version,
      changedRevision: row.changedRevision,
      createdAt: row.createdAt.getTime(),
      updatedAt: row.updatedAt.getTime(),
      deletedAt: row.deletedAt?.getTime() ?? null,
    }
  }

  async function getFeedStateReplica(userId: string): Promise<FeedStateReplica> {
    const rows = await database
      .select({
        activityClearedAt: userFeedState.activityClearedAt,
        version: userFeedState.entityVersion,
        changedRevision: sql<string>`cast(${userFeedState.changedRevision} as text)`,
      })
      .from(userFeedState)
      .where(eq(userFeedState.userId, userId))
      .limit(1)
    const row = rows[0]
    return row
      ? {
          activityClearedAt: row.activityClearedAt.getTime(),
          version: row.version,
          changedRevision: row.changedRevision,
        }
      : { activityClearedAt: 0, version: 0, changedRevision: '0' }
  }

  async function getStoredReceipt(userId: string, attemptId: string) {
    const rows = await database
      .select({ result: userMutationReceipt.result })
      .from(userMutationReceipt)
      .where(
        and(eq(userMutationReceipt.userId, userId), eq(userMutationReceipt.attemptId, attemptId)),
      )
      .limit(1)
    if (rows[0]) {
      return rows[0].result
    }

    // Compaction may remove a receipt after its retry window. The latest
    // successful attempt for an entity remains reconstructable from the
    // canonical row, preserving exact idempotency without retaining that
    // receipt forever. Older attempts are still protected by entity CAS.
    const [filters, feedStates] = await Promise.all([
      database
        .select({
          id: userFilter.id,
          name: userFilter.name,
          filterRule: userFilter.filterRule,
          version: userFilter.entityVersion,
          changedRevision: sql<string>`cast(${userFilter.changedRevision} as text)`,
          createdAt: userFilter.createdAt,
          updatedAt: userFilter.updatedAt,
          deletedAt: userFilter.deletedAt,
        })
        .from(userFilter)
        .where(and(eq(userFilter.userId, userId), eq(userFilter.lastAttemptId, attemptId)))
        .limit(1),
      database
        .select({
          activityClearedAt: userFeedState.activityClearedAt,
          version: userFeedState.entityVersion,
          changedRevision: sql<string>`cast(${userFeedState.changedRevision} as text)`,
        })
        .from(userFeedState)
        .where(and(eq(userFeedState.userId, userId), eq(userFeedState.lastAttemptId, attemptId)))
        .limit(1),
    ])
    const filter = filters[0]
    if (filter) {
      return JSON.stringify({
        id: filter.id,
        name: filter.name,
        filterRule: parseStoredFilterRuleForWire(filter.filterRule),
        version: filter.version,
        changedRevision: filter.changedRevision,
        createdAt: filter.createdAt.getTime(),
        updatedAt: filter.updatedAt.getTime(),
        deletedAt: filter.deletedAt?.getTime() ?? null,
      })
    }
    const feedState = feedStates[0]
    return feedState
      ? JSON.stringify({
          activityClearedAt: feedState.activityClearedAt.getTime(),
          version: feedState.version,
          changedRevision: feedState.changedRevision,
        })
      : undefined
  }

  async function pushFilterMutation(
    userId: string,
    mutation: Extract<LocalFeedUserMutation, { kind: 'filter.put' | 'filter.delete' }>,
  ) {
    const existingReceipt = await getStoredReceipt(userId, mutation.attemptId)
    if (existingReceipt) {
      return {
        kind: 'already-applied' as const,
        entityKind: 'filter' as const,
        replica: parseFilterReplica(existingReceipt),
      }
    }
    const changedAt = now()
    const changedAtMs = changedAt.getTime()
    const id = mutation.kind === 'filter.put' ? mutation.filter.id : mutation.id
    const noReceipt = sql`not exists (
      select 1 from ${userMutationReceipt}
      where ${userMutationReceipt.userId} = ${userId}
        and ${userMutationReceipt.attemptId} = ${mutation.attemptId}
    )`
    const entityMutation =
      mutation.kind === 'filter.put'
        ? database
            .insert(userFilter)
            .select(sql`
              select
                ${mutation.filter.id},
                ${userId},
                ${mutation.filter.name},
                ${serializeFilterGroup(filterGroupSchema.parse(mutation.filter.filterRule))},
                ${changedAtMs},
                ${changedAtMs},
                1,
                0,
                null,
                ${mutation.attemptId}
              where ${noReceipt}
                and (
                  ${mutation.baseVersion} = 0
                  or exists (
                    select 1 from ${userFilter}
                    where ${userFilter.userId} = ${userId}
                      and ${userFilter.id} = ${mutation.filter.id}
                  )
                )
            `)
            .onConflictDoUpdate({
              target: userFilter.id,
              set: {
                name: mutation.filter.name,
                filterRule: serializeFilterGroup(
                  filterGroupSchema.parse(mutation.filter.filterRule),
                ),
                updatedAt: changedAt,
                entityVersion: sql`${userFilter.entityVersion} + 1`,
                lastAttemptId: mutation.attemptId,
              },
              where: and(
                eq(userFilter.userId, userId),
                eq(userFilter.entityVersion, mutation.baseVersion),
                isNull(userFilter.deletedAt),
                noReceipt,
              ),
            })
        : database
            .update(userFilter)
            .set({
              deletedAt: changedAt,
              updatedAt: changedAt,
              entityVersion: sql`${userFilter.entityVersion} + 1`,
              lastAttemptId: mutation.attemptId,
            })
            .where(
              and(
                eq(userFilter.userId, userId),
                eq(userFilter.id, mutation.id),
                eq(userFilter.entityVersion, mutation.baseVersion),
                isNull(userFilter.deletedAt),
                noReceipt,
              ),
            )

    const [entityResult] = await database.batch([
      entityMutation,
      database.insert(userStateChange).select(sql`
        select
          null,
          ${userId},
          'filter',
          ${id},
          ${userFilter.entityVersion},
          ${changedAtMs}
        from ${userFilter}
        where ${userFilter.userId} = ${userId}
          and ${userFilter.id} = ${id}
          and ${userFilter.lastAttemptId} = ${mutation.attemptId}
          and ${userFilter.entityVersion} = ${mutation.baseVersion + 1}
          and ${noReceipt}
      `),
      database
        .insert(userMutationReceipt)
        .select(sql`
          select
            ${userId},
            ${mutation.attemptId},
            ${mutation.mutationId},
            'filter',
            ${id},
            json_object(
              'id', ${userFilter.id},
              'name', ${userFilter.name},
              'filterRule', case
                when json_valid(${userFilter.filterRule}) then json(${userFilter.filterRule})
                else ${userFilter.filterRule}
              end,
              'version', ${userFilter.entityVersion},
              'changedRevision', cast(${userFilter.changedRevision} as text),
              'createdAt', ${userFilter.createdAt},
              'updatedAt', ${userFilter.updatedAt},
              'deletedAt', ${userFilter.deletedAt}
            ),
            ${changedAtMs}
          from ${userFilter}
          where ${userFilter.userId} = ${userId}
            and ${userFilter.id} = ${id}
            and ${userFilter.lastAttemptId} = ${mutation.attemptId}
            and ${userFilter.entityVersion} = ${mutation.baseVersion + 1}
            and ${noReceipt}
        `)
        .onConflictDoNothing(),
    ])
    // The receipt is created by the atomic batch above.
    // oxlint-disable-next-line react-doctor/server-sequential-independent-await
    const receipt = await getStoredReceipt(userId, mutation.attemptId)
    if (receipt) {
      return {
        kind: entityResult.meta.changes > 0 ? ('applied' as const) : ('already-applied' as const),
        entityKind: 'filter' as const,
        replica: parseFilterReplica(receipt),
      }
    }
    return {
      kind: 'conflict' as const,
      entityKind: 'filter' as const,
      currentReplica: await getFilterReplica(userId, id),
    }
  }

  function parseFeedStateReplica(value: string) {
    return JSON.parse(value) as FeedStateReplica
  }

  async function pushClearMutation(
    userId: string,
    viewerGithubId: string,
    serverEpoch: string,
    mutation: Extract<LocalFeedUserMutation, { kind: 'feed.clear' }>,
  ) {
    const existingReceipt = await getStoredReceipt(userId, mutation.attemptId)
    if (existingReceipt) {
      return {
        kind: 'already-applied' as const,
        entityKind: 'feed-state' as const,
        replica: parseFeedStateReplica(existingReceipt),
      }
    }
    const changedAt = now()
    const changedAtMs = changedAt.getTime()
    const anchorValue = await readTimeAnchor(viewerGithubId, serverEpoch, mutation.timeAnchor)
    const candidate =
      anchorValue !== null
        ? Math.min(changedAtMs, Math.max(anchorValue, mutation.candidate))
        : changedAtMs
    const noReceipt = sql`not exists (
      select 1 from ${userMutationReceipt}
      where ${userMutationReceipt.userId} = ${userId}
        and ${userMutationReceipt.attemptId} = ${mutation.attemptId}
    )`
    const [entityResult] = await database.batch([
      database
        .insert(userFeedState)
        .select(sql`
          select ${userId}, ${candidate}, 1, 0, ${mutation.attemptId}
          where ${noReceipt}
            and (
              ${mutation.baseVersion} = 0
              or exists (
                select 1 from ${userFeedState}
                where ${userFeedState.userId} = ${userId}
              )
            )
        `)
        .onConflictDoUpdate({
          target: userFeedState.userId,
          set: {
            activityClearedAt: sql`max(${userFeedState.activityClearedAt}, ${candidate})`,
            entityVersion: sql`
              ${userFeedState.entityVersion}
              + case when ${candidate} > ${userFeedState.activityClearedAt} then 1 else 0 end
            `,
            lastAttemptId: mutation.attemptId,
          },
          where: and(eq(userFeedState.entityVersion, mutation.baseVersion), noReceipt),
        }),
      database.insert(userStateChange).select(sql`
        select
          null,
          ${userId},
          'feed-state',
          'feed',
          ${userFeedState.entityVersion},
          ${changedAtMs}
        from ${userFeedState}
        where ${userFeedState.userId} = ${userId}
          and ${userFeedState.lastAttemptId} = ${mutation.attemptId}
          and ${userFeedState.entityVersion} = ${mutation.baseVersion + 1}
          and ${noReceipt}
      `),
      database
        .insert(userMutationReceipt)
        .select(sql`
          select
            ${userId},
            ${mutation.attemptId},
            ${mutation.mutationId},
            'feed-state',
            'feed',
            json_object(
              'activityClearedAt', ${userFeedState.activityClearedAt},
              'version', ${userFeedState.entityVersion},
              'changedRevision', cast(${userFeedState.changedRevision} as text)
            ),
            ${changedAtMs}
          from ${userFeedState}
          where ${userFeedState.userId} = ${userId}
            and ${userFeedState.lastAttemptId} = ${mutation.attemptId}
            and ${noReceipt}
        `)
        .onConflictDoNothing(),
    ])
    // The receipt is created by the atomic batch above.
    // oxlint-disable-next-line react-doctor/server-sequential-independent-await
    const receipt = await getStoredReceipt(userId, mutation.attemptId)
    if (receipt) {
      return {
        kind: entityResult.meta.changes > 0 ? ('applied' as const) : ('already-applied' as const),
        entityKind: 'feed-state' as const,
        replica: parseFeedStateReplica(receipt),
      }
    }
    return {
      kind: 'conflict' as const,
      entityKind: 'feed-state' as const,
      currentReplica: await getFeedStateReplica(userId),
    }
  }

  function toFilterReplica(row: {
    id: string
    name: string
    filterRule: string
    version: number
    changedRevision: string
    createdAt: Date
    updatedAt: Date
    deletedAt: Date | null
  }) {
    return {
      id: row.id,
      name: row.name,
      filterRule: parseStoredFilterRule(row.filterRule),
      version: row.version,
      changedRevision: row.changedRevision,
      createdAt: row.createdAt.getTime(),
      updatedAt: row.updatedAt.getTime(),
      deletedAt: row.deletedAt?.getTime() ?? null,
    }
  }

  const filterReplicaSelection = {
    id: userFilter.id,
    name: userFilter.name,
    filterRule: userFilter.filterRule,
    version: userFilter.entityVersion,
    changedRevision: sql<string>`cast(${userFilter.changedRevision} as text)`,
    createdAt: userFilter.createdAt,
    updatedAt: userFilter.updatedAt,
    deletedAt: userFilter.deletedAt,
  }

  async function listFilterReplicas(userId: string, ids?: string[]) {
    const rows = await database
      .select({
        ...filterReplicaSelection,
      })
      .from(userFilter)
      .where(
        and(
          eq(userFilter.userId, userId),
          ids ? (ids.length > 0 ? inArray(userFilter.id, ids) : sql`false`) : undefined,
        ),
      )
      .orderBy(asc(userFilter.id))
    return rows.map(toFilterReplica)
  }

  async function listSnapshotFilterReplicas(userId: string, position: string, limit: number) {
    const rows = await database
      .select({
        ...filterReplicaSelection,
        snapshotPosition: sql<string>`cast(${userFilter}._rowid_ as text)`,
      })
      .from(userFilter)
      .where(
        and(
          eq(userFilter.userId, userId),
          sql`${userFilter}._rowid_ > cast(${position} as integer)`,
        ),
      )
      .orderBy(sql`${userFilter}._rowid_ asc`)
      .limit(limit + 1)
    return rows.map(row => ({
      replica: toFilterReplica(row),
      snapshotPosition: row.snapshotPosition,
    }))
  }

  return {
    async getManifest(userId: string) {
      const serverEpoch = await resolveServerEpoch()
      const [viewerGithubId, activityRows, followingRows, userState] = await Promise.all([
        getViewerGithubId(userId),
        database
          .select({
            headSeq: sql<string>`cast(${activitySyncState.headSeq} as text)`,
            retentionGeneration: sql<string>`cast(${activitySyncState.retentionGeneration} as text)`,
          })
          .from(activitySyncState)
          .where(eq(activitySyncState.id, 1))
          .limit(1),
        database
          .select({
            revision: followingSyncState.activeRevision,
            completedAt: followingSyncState.completedAt,
            reauthRequiredAt: followingSyncState.reauthRequiredAt,
          })
          .from(followingSyncState)
          .where(eq(followingSyncState.userId, userId))
          .limit(1),
        ensureUserState(userId, serverEpoch),
      ])
      const serverTime = now().getTime()
      const activity = activityRows[0] ?? { headSeq: '0', retentionGeneration: '0' }
      return {
        protocol: 1 as const,
        serverEpoch,
        viewerGithubId,
        serverTime,
        timeAnchor: await createTimeAnchor(viewerGithubId, serverTime, serverEpoch),
        activity,
        following: {
          revision: followingRows[0]?.revision ?? null,
          completedAt: followingRows[0]?.completedAt?.getTime() ?? null,
          reauthRequiredAt: followingRows[0]?.reauthRequiredAt?.getTime() ?? null,
        },
        userState: { revision: userState.revision, epoch: userState.epoch },
      }
    },

    async getFollowingPage(
      userId: string,
      input: { revision: string; cursor?: string; limit?: number },
    ) {
      const [viewerGithubId, serverEpoch] = await Promise.all([
        getViewerGithubId(userId),
        resolveServerEpoch(),
      ])
      const limit = Math.max(1, Math.min(input.limit ?? 100, 250))
      const cursor = input.cursor ? await decodeCursor(input.cursor, serverEpoch) : undefined
      if (
        cursor &&
        (cursor.kind !== 'following' ||
          cursor.userId !== userId ||
          cursor.revision !== input.revision ||
          !Number.isSafeInteger(cursor.position))
      ) {
        throw new LocalFeedCursorError()
      }
      const rows = await database
        .select({
          snapshotRevision: followingSnapshot.revision,
          actorKey: followingMember.actorKey,
          githubId: followingMember.githubId,
          login: followingMember.login,
          legacyActorKeys: followingMember.legacyActorKeys,
          position: followingMember.position,
        })
        .from(followingSnapshot)
        .leftJoin(
          followingMember,
          and(
            eq(followingMember.revision, followingSnapshot.revision),
            cursor ? gt(followingMember.position, cursor.position) : undefined,
          ),
        )
        .where(
          and(eq(followingSnapshot.revision, input.revision), eq(followingSnapshot.userId, userId)),
        )
        .orderBy(asc(followingMember.position))
        .limit(limit + 1)
      if (!rows[0]) {
        throw new FollowingSnapshotExpiredError()
      }
      const memberRows = rows.filter(
        (
          row,
        ): row is typeof row & {
          actorKey: string
          githubId: string
          login: string
          legacyActorKeys: string
          position: number
        } =>
          row.actorKey !== null &&
          row.githubId !== null &&
          row.login !== null &&
          row.legacyActorKeys !== null &&
          row.position !== null,
      )
      const hasMore = memberRows.length > limit
      const pageRows = memberRows.slice(0, limit)
      const last = pageRows.at(-1)
      return {
        viewerGithubId,
        revision: input.revision,
        items: pageRows.map(row => ({
          actorKey: row.actorKey,
          githubId: row.githubId,
          login: row.login,
          legacyActorKeys: JSON.parse(row.legacyActorKeys) as string[],
        })),
        nextCursor:
          hasMore && last
            ? await encodeCursor(
                {
                  protocol: 1,
                  serverEpoch,
                  kind: 'following',
                  userId,
                  revision: input.revision,
                  position: last.position,
                },
                serverEpoch,
              )
            : null,
      }
    },

    async getActivityHistoryPage(
      userId: string,
      input: {
        scope: ActivityScope
        cursor?: string
        limit?: number
        targetThroughSeq?: string
      },
    ) {
      const [viewerGithubId, resolvedScope, serverEpoch] = await Promise.all([
        getViewerGithubId(userId),
        resolveActivityScope(userId, input.scope),
        resolveServerEpoch(),
      ])
      const retention = await getRetentionFacts(resolvedScope.actorKeys)
      const decoded = input.cursor ? await decodeCursor(input.cursor, serverEpoch) : undefined
      if (decoded && decoded.kind !== 'activity-history') {
        throw new LocalFeedCursorError()
      }
      const cursor = decoded?.kind === 'activity-history' ? decoded : undefined
      const throughSeq = cursor
        ? assertSequence(cursor.throughSeq)
        : await resolveThroughSeq(input.targetThroughSeq)
      if (
        cursor &&
        (typeof cursor.scopeKey !== 'string' ||
          typeof cursor.retentionFingerprint !== 'string' ||
          typeof cursor.activityId !== 'string' ||
          cursor.userId !== userId ||
          cursor.scopeKey !== resolvedScope.scopeKey ||
          (input.targetThroughSeq !== undefined && input.targetThroughSeq !== cursor.throughSeq) ||
          !Number.isSafeInteger(cursor.publishedAtMs))
      ) {
        throw new LocalFeedCursorError()
      }
      if (cursor && cursor.retentionFingerprint !== retention.fingerprint) {
        throw new ActivityRetentionChangedError()
      }
      const limit = Math.max(1, Math.min(input.limit ?? 100, 250))
      const scopeCondition =
        resolvedScope.actorKeys.length === 0
          ? sql`false`
          : input.scope.kind === 'actors'
            ? sql`unlikely(${inArray(feedItem.actorKey, resolvedScope.actorKeys)})`
            : sql`
              ${feedItem.actorKey}
              in (select value from json_each(${JSON.stringify(resolvedScope.actorKeys)}))
            `
      const rows = await database
        .select({
          ...activitySelection,
          seq: sql<string>`cast(${activityChange.seq} as text)`,
        })
        .from(activityChange)
        .innerJoin(
          feedItem,
          and(
            eq(activityChange.source, feedItem.source),
            eq(activityChange.activityId, feedItem.id),
          ),
        )
        .where(
          and(
            scopeCondition,
            eq(feedItem.hidden, false),
            sql`${activityChange.seq} <= cast(${throughSeq} as integer)`,
            cursor
              ? or(
                  lt(feedItem.publishedAt, new Date(cursor.publishedAtMs)),
                  and(
                    eq(feedItem.publishedAt, new Date(cursor.publishedAtMs)),
                    lt(feedItem.id, cursor.activityId),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(desc(feedItem.publishedAt), desc(feedItem.id))
        .limit(limit + 1)
      const hasMore = rows.length > limit
      const pageRows = rows.slice(0, limit)
      const last = pageRows.at(-1)
      const finalRetention = await getRetentionFacts(resolvedScope.actorKeys)
      if (finalRetention.fingerprint !== retention.fingerprint) {
        throw new ActivityRetentionChangedError()
      }
      return {
        viewerGithubId,
        scopeKey: resolvedScope.scopeKey,
        throughSeq,
        retentionFingerprint: retention.fingerprint,
        items: pageRows.map(toRawActivity),
        nextCursor:
          hasMore && last
            ? await encodeCursor(
                {
                  protocol: 1,
                  serverEpoch,
                  kind: 'activity-history',
                  userId,
                  scopeKey: resolvedScope.scopeKey,
                  throughSeq,
                  retentionFingerprint: retention.fingerprint,
                  publishedAtMs: last.publishedAt.getTime(),
                  activityId: last.id,
                },
                serverEpoch,
              )
            : null,
        remoteWindowEnd: !hasMore,
      }
    },

    async getActivityDeltaPage(
      userId: string,
      input: {
        scope: ActivityScope
        fromSeq: string
        cursor?: string
        limit?: number
        targetThroughSeq?: string
      },
    ) {
      const [viewerGithubId, resolvedScope, serverEpoch] = await Promise.all([
        getViewerGithubId(userId),
        resolveActivityScope(userId, input.scope),
        resolveServerEpoch(),
      ])
      const fromSeq = assertSequence(input.fromSeq)
      const retention = await getRetentionFacts(resolvedScope.actorKeys)
      const decoded = input.cursor ? await decodeCursor(input.cursor, serverEpoch) : undefined
      if (decoded && decoded.kind !== 'activity-delta') {
        throw new LocalFeedCursorError()
      }
      const cursor = decoded?.kind === 'activity-delta' ? decoded : undefined
      const throughSeq = cursor
        ? assertSequence(cursor.throughSeq)
        : await resolveThroughSeq(input.targetThroughSeq)
      if (
        BigInt(fromSeq) > BigInt(throughSeq) ||
        (cursor &&
          (typeof cursor.scopeKey !== 'string' ||
            typeof cursor.retentionFingerprint !== 'string' ||
            assertSequence(cursor.fromSeq) !== fromSeq ||
            assertSequence(cursor.lastSeq) !== cursor.lastSeq ||
            typeof cursor.lastActivityId !== 'string' ||
            cursor.userId !== userId ||
            cursor.scopeKey !== resolvedScope.scopeKey ||
            (input.targetThroughSeq !== undefined && input.targetThroughSeq !== cursor.throughSeq)))
      ) {
        throw new LocalFeedCursorError()
      }
      if (cursor && cursor.retentionFingerprint !== retention.fingerprint) {
        throw new ActivityRetentionChangedError()
      }
      let compacted: string | undefined
      for (const actor of retention.actors) {
        const sequence = actor.compactedThroughSeq
        if (
          BigInt(sequence) > BigInt(fromSeq) &&
          (compacted === undefined || BigInt(sequence) > BigInt(compacted))
        ) {
          compacted = sequence
        }
      }
      if (compacted) {
        return {
          viewerGithubId,
          scopeKey: resolvedScope.scopeKey,
          throughSeq,
          retentionFingerprint: retention.fingerprint,
          gap: { compactedThroughSeq: compacted },
          items: [],
          nextCursor: null,
        }
      }
      const limit = Math.max(1, Math.min(input.limit ?? 100, 250))
      const startSeq = cursor?.lastSeq ?? fromSeq
      const scopeCondition =
        resolvedScope.actorKeys.length === 0
          ? sql`false`
          : input.scope.kind === 'actors'
            ? sql`unlikely(${inArray(activityChange.actorKey, resolvedScope.actorKeys)})`
            : sql`
              ${activityChange.actorKey}
              in (select value from json_each(${JSON.stringify(resolvedScope.actorKeys)}))
            `
      const rows = await database
        .select({
          ...activitySelection,
          seq: sql<string>`cast(${activityChange.seq} as text)`,
        })
        .from(activityChange)
        .innerJoin(
          feedItem,
          and(
            eq(activityChange.source, feedItem.source),
            eq(activityChange.activityId, feedItem.id),
          ),
        )
        .where(
          and(
            scopeCondition,
            eq(feedItem.hidden, false),
            cursor
              ? sql`(
                  ${activityChange.seq} > cast(${startSeq} as integer)
                  or (
                    ${activityChange.seq} = cast(${startSeq} as integer)
                    and ${activityChange.activityId} > ${cursor.lastActivityId}
                  )
                )`
              : sql`${activityChange.seq} > cast(${startSeq} as integer)`,
            sql`${activityChange.seq} <= cast(${throughSeq} as integer)`,
          ),
        )
        .orderBy(asc(activityChange.seq), asc(activityChange.activityId))
        .limit(limit + 1)
      const hasMore = rows.length > limit
      const pageRows = rows.slice(0, limit)
      const last = pageRows.at(-1)
      const finalRetention = await getRetentionFacts(resolvedScope.actorKeys)
      if (finalRetention.fingerprint !== retention.fingerprint) {
        throw new ActivityRetentionChangedError()
      }
      return {
        viewerGithubId,
        scopeKey: resolvedScope.scopeKey,
        throughSeq,
        retentionFingerprint: retention.fingerprint,
        gap: null,
        items: pageRows.map(toRawActivity),
        nextCursor:
          hasMore && last
            ? await encodeCursor(
                {
                  protocol: 1,
                  serverEpoch,
                  kind: 'activity-delta',
                  userId,
                  scopeKey: resolvedScope.scopeKey,
                  fromSeq,
                  throughSeq,
                  retentionFingerprint: retention.fingerprint,
                  lastSeq: last.seq,
                  lastActivityId: last.id,
                },
                serverEpoch,
              )
            : null,
      }
    },

    async getActivityById(userId: string, id: string) {
      const [viewerGithubId, rows] = await Promise.all([
        getViewerGithubId(userId),
        database
          .select({ ...activitySelection, authorizedActorKey: followingMember.actorKey })
          .from(feedItem)
          .leftJoin(followingSyncState, eq(followingSyncState.userId, userId))
          .leftJoin(
            followingSnapshot,
            and(
              eq(followingSnapshot.userId, userId),
              eq(followingSnapshot.revision, followingSyncState.activeRevision),
            ),
          )
          .leftJoin(
            followingMember,
            and(
              eq(followingMember.revision, followingSnapshot.revision),
              or(
                eq(followingMember.actorKey, feedItem.actorKey),
                sql`exists (
                  select 1 from json_each(${followingMember.legacyActorKeys})
                  where value = ${feedItem.actorKey}
                )`,
              ),
            ),
          )
          .where(and(eq(feedItem.id, id), eq(feedItem.hidden, false)))
          .limit(1),
      ])
      const row = rows[0]
      if (!row) {
        return { viewerGithubId, result: { kind: 'cloud-miss' as const } }
      }
      return row.authorizedActorKey
        ? {
            viewerGithubId,
            result: { kind: 'found' as const, activity: toRawActivity(row) },
          }
        : { viewerGithubId, result: { kind: 'not-authorized' as const } }
    },

    async pullUserState(
      userId: string,
      input: { afterSeq?: string; epoch?: string; limit?: number } = {},
    ) {
      const serverEpoch = await resolveServerEpoch()
      const [viewerGithubId, state] = await Promise.all([
        getViewerGithubId(userId),
        ensureUserState(userId, serverEpoch),
      ])
      const limit = Math.max(1, Math.min(input.limit ?? 100, 250))
      const cursorValue = input.afterSeq ?? '0'
      const snapshotCursor = /^(0|[1-9]\d*)$/.test(cursorValue)
        ? null
        : await decodeCursor(cursorValue, serverEpoch)
      const afterSeq = snapshotCursor ? '0' : assertSequence(cursorValue)
      if (
        snapshotCursor &&
        (snapshotCursor.kind !== 'user-state-snapshot' ||
          snapshotCursor.userId !== userId ||
          snapshotCursor.epoch !== state.epoch ||
          BigInt(assertSequence(snapshotCursor.targetRevision)) > BigInt(state.revision) ||
          BigInt(assertSequence(snapshotCursor.position)) >= 1n << 63n)
      ) {
        throw new LocalFeedCursorError()
      }
      const needsSnapshot =
        snapshotCursor !== null ||
        input.epoch === undefined ||
        input.epoch !== state.epoch ||
        BigInt(afterSeq) < BigInt(state.compactedThroughSeq)
      if (!needsSnapshot && BigInt(afterSeq) > BigInt(state.revision)) {
        throw new LocalFeedCursorError()
      }

      const buildSnapshot = async (
        targetRevision: string,
        position: string,
        compactedThroughSeq: string,
      ) => {
        const rows = await listSnapshotFilterReplicas(userId, position, limit)
        const hasMore = rows.length > limit
        const pageRows = rows.slice(0, limit)
        const last = pageRows.at(-1)
        return {
          viewerGithubId,
          mode: 'snapshot' as const,
          revision: targetRevision,
          epoch: state.epoch,
          compactedThroughSeq,
          filters: pageRows.map(row => row.replica),
          feedState: await getFeedStateReplica(userId),
          nextCursor:
            hasMore && last
              ? await encodeUserStateSnapshotCursor({
                  userId,
                  epoch: state.epoch,
                  targetRevision,
                  position: last.snapshotPosition,
                  serverEpoch,
                })
              : null,
        }
      }

      if (needsSnapshot) {
        return buildSnapshot(
          snapshotCursor?.targetRevision ?? state.revision,
          snapshotCursor?.position ?? '0',
          state.compactedThroughSeq,
        )
      }

      const changes = await database
        .select({
          seq: sql<string>`cast(${userStateChange.seq} as text)`,
          entityKind: userStateChange.entityKind,
          entityId: userStateChange.entityId,
        })
        .from(userStateChange)
        .where(
          and(
            eq(userStateChange.userId, userId),
            sql`${userStateChange.seq} > cast(${afterSeq} as integer)`,
            sql`${userStateChange.seq} <= cast(${state.revision} as integer)`,
          ),
        )
        .orderBy(asc(userStateChange.seq))
        .limit(limit + 1)

      // Compaction can race the separate D1 reads above. Re-checking the floor
      // prevents a delta response from skipping rows deleted between them.
      // oxlint-disable-next-line react-doctor/server-sequential-independent-await
      const finalState = await ensureUserState(userId, serverEpoch)
      if (BigInt(afterSeq) < BigInt(finalState.compactedThroughSeq)) {
        return buildSnapshot(finalState.revision, '0', finalState.compactedThroughSeq)
      }
      const hasMore = changes.length > limit
      const pageChanges = changes.slice(0, limit)
      const uniqueFilterIds = new Set<string>()
      for (const change of pageChanges) {
        if (change.entityKind === 'filter') {
          uniqueFilterIds.add(change.entityId)
        }
      }
      return {
        viewerGithubId,
        mode: 'delta' as const,
        revision: state.revision,
        epoch: state.epoch,
        compactedThroughSeq: state.compactedThroughSeq,
        filters: await listFilterReplicas(userId, [...uniqueFilterIds]),
        feedState: await getFeedStateReplica(userId),
        nextCursor: hasMore ? (pageChanges.at(-1)?.seq ?? null) : null,
      }
    },

    async pushUserMutation(userId: string, mutation: LocalFeedUserMutation) {
      if (
        !Number.isSafeInteger(mutation.baseVersion) ||
        mutation.baseVersion < 0 ||
        (mutation.kind === 'feed.clear' && !Number.isSafeInteger(mutation.candidate)) ||
        mutation.mutationId.length === 0 ||
        mutation.attemptId.length === 0
      ) {
        throw new LocalFeedCursorError()
      }
      const [viewerGithubId, serverEpoch] = await Promise.all([
        getViewerGithubId(userId),
        resolveServerEpoch(),
      ])
      await ensureUserState(userId, serverEpoch)
      const result =
        mutation.kind === 'feed.clear'
          ? await pushClearMutation(userId, viewerGithubId, serverEpoch, mutation)
          : await pushFilterMutation(userId, mutation)
      return { viewerGithubId, ...result }
    },

    async applyLegacyUserMutation(userId: string, mutation: LocalFeedUserMutation) {
      const serverEpoch = await resolveServerEpoch()
      await ensureUserState(userId, serverEpoch)
      return mutation.kind === 'feed.clear'
        ? pushClearMutation(userId, '', serverEpoch, mutation)
        : pushFilterMutation(userId, mutation)
    },

    async commitLegacyClear(userId: string) {
      const serverEpoch = await resolveServerEpoch()
      await ensureUserState(userId, serverEpoch)
      const mutationId = crypto.randomUUID()
      const candidate = now().getTime()
      let current = await getFeedStateReplica(userId)
      for (let attempt = 0; attempt < 8; attempt += 1) {
        // A legacy client has no replica version to rebase itself. Retry the
        // monotonic clear against the latest canonical version on its behalf.
        // oxlint-disable-next-line react-doctor/async-await-in-loop
        const result = await pushClearMutation(userId, '', serverEpoch, {
          kind: 'feed.clear',
          mutationId,
          attemptId: crypto.randomUUID(),
          baseVersion: current.version,
          candidate,
        })
        if (result.kind !== 'conflict') {
          return result
        }
        current = result.currentReplica
      }
      throw new Error('Legacy Feed clear was repeatedly superseded')
    },
  }
}
