import type { FilterGroup } from '@better-github-feed/shared'
import Dexie from 'dexie'
import type { EntityTable, Table } from 'dexie'

import type { FollowingTransitionPlan } from './following-transition'
import type { LocalSyncStatus } from './types'

export type MetaRow = {
  key: string
  value: string | number | boolean | null
}

export type ActorRow = {
  actorKey: string
  githubId: string | null
  login: string
  normalizedLogin: string
  avatarUrl: string | null
}

export type ActivityRow = {
  id: string
  actorKey: string
  actorLogin: string
  title: string
  link: string | null
  repo: string | null
  type: string
  publishedAt: number
  source: 'github-atom-v1'
  insertedRevision: number
}

export function normalizeInsertedRevision(value: unknown) {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : 0
}

export type ActivityBodyRow = {
  activityId: string
  summary: string | null
  content: string | null
  sanitizerVersion: string
}

export type ActivityProjectionFactRow = {
  key: string
  generation: number
  activityId: string
  actorKey: string
  type: string
  publishedAt: number
  visible: 0 | 1
}

export type ActivityAggregateRow = {
  key: string
  generation: number
  actorKey: string
  type: string
  count: number
  latest: number
}

export type ActivityTypeAggregateRow = {
  key: string
  generation: number
  type: string
  count: number
}

export type FollowingSummaryRow = {
  key: string
  generation: number
  actorKey: string
  normalizedLogin: string
  sortKey: string
  count: number
  latest: number
}

export type ActivityProjectionStateRow = {
  key: 'activity'
  activeGeneration: number | null
  activeSignature: string | null
  activeThroughRevision: number
  buildingGeneration: number | null
  buildingSignature: string | null
  buildingCursorRevision: number | null
  buildingCursorId: string | null
  buildingTargetRevision: number | null
  nextGeneration: number
  sanitizerVersion: string | null
  garbageGenerations: number[]
  buildingFollowingInitialized?: boolean
  buildingFollowingCursorActorKey?: string | null
  followingDisplayRevision?: string | null
  followingDisplayTargetRevision?: string | null
  followingDisplayCursorActorKey?: string | null
}

export type FollowingMemberRow = {
  snapshotRevision: string
  actorKey: string
  actorId: string
  login: string
  normalizedLogin: string
  avatarUrl?: string | null
  followedAt: number
  legacyActorKeys: readonly string[]
}

export type FollowingMembershipRow = {
  snapshotRevision: string
  actorKey: string
  memberActorKey: string
}

export type FollowingAdditionRow = {
  snapshotRevision: string
  actorKey: string
}

export type FollowingStateRow = {
  key: 'active'
  activeRevision: string | null
  stagingRevision: string | null
  stagingCursor: string | null
  stagingComplete?: boolean
  stagingFinalizeCursorActorKey?: string | null
  stagingMembershipDigest?: string | null
  stagingMembershipCount?: number
  pendingTransition?: FollowingTransitionPlan | null
  membershipSignature?: string | null
}

export type FilterValue = {
  name: string
  rule: FilterGroup | null
  invalidLegacyRule?: unknown
}

export type FilterReplicaRow = {
  id: string
  entityVersion: number
  changedRevision: string
  value: FilterValue | null
  deletedAt: number | null
}

export type FilterRow = {
  id: string
  name: string
  rule: FilterGroup | null
  invalidLegacyRule?: unknown
  deletedAt: number | null
  sync: 'synced' | 'pending' | 'conflict-copy'
  updatedAt: number
}

export type FeedStateRow = {
  key: 'active'
  entityVersion: number
  changedRevision: string
  serverClearedAt: number | null
  optimisticClearedAt: number | null
  provisionalThroughRevision: number | null
}

export type FilterPutOperation = {
  kind: 'filter.put'
  filter: { id: string; name: string; rule: FilterGroup }
}

export type FilterDeleteOperation = {
  kind: 'filter.delete'
  id: string
}

export type FeedClearOperation = {
  kind: 'feed.clear'
  candidate: number | null
  timeAnchor: string | null
}

export type OutboxOperation = FilterPutOperation | FilterDeleteOperation | FeedClearOperation

export type OutboxRow = {
  mutationId: string
  attemptId: string
  localSequence: number
  entityKey: string
  baseVersion: number
  baseValue: FilterValue | number | null
  operation: OutboxOperation
  status: 'pending' | 'blocked'
  conflictCopy: boolean
  createdAt: number
}

export type SyncLaneRow = {
  scopeKey: string
  kind: 'activity'
  remoteScopeKey: string | null
  stableThroughSeq: string | null
  historyThroughSeq: string | null
  historyCursor: string | null
  historyRetentionFingerprint: string | null
  checkpointAfterHistory: boolean
  historyBudgetToken: string | null
  historyBudgetExhausted: boolean
  historyBudgetPageCount: number
  historyBudgetItemCount: number
  deltaThroughSeq: string | null
  deltaCursor: string | null
  deltaRetentionFingerprint: string | null
  lastUsedAt: number
}

export type CoverageRow = {
  scopeKey: string
  bootstrap: 'never-synced' | 'initialized'
  remoteWindow: 'unchecked' | 'may-have-more' | 'exhausted'
  integrity: 'continuous' | 'gap-detected'
}

export type SyncStateRow = {
  key: string
  manifestEtag?: string
  bookmark?: string
  userStateRevision?: string
  userStateEpoch?: string
  lastCloudContactAt?: number
  retryAt?: number
  status?: LocalSyncStatus
  activityResult?:
    | 'resolving'
    | 'unavailable-offline'
    | 'cloud-unavailable'
    | 'not-authorized'
    | 'cloud-miss'
  activityResultAtHeadSeq?: string
  activityResultAtFollowingRevision?: string | null
  manifestServerTime?: number
  manifestTimeAnchor?: string
  manifestReceivedAt?: number
  manifestServerEpoch?: string
  manifestActivityHeadSeq?: string
  manifestActivityRetentionGeneration?: string
  manifestFollowingRevision?: string | null
  manifestFollowingCompletedAt?: number | null
  manifestFollowingReauthRequiredAt?: number | null
  manifestUserStateRevision?: string
  manifestUserStateEpoch?: string
}

export type SyncLeaseRow = {
  key: 'leader'
  owner: string
  expiresAt: number
  fencingToken: string
}

export class LocalFeedDatabase extends Dexie {
  volatileLocalRevision = 0
  volatileSyncStatus: LocalSyncStatus | undefined
  meta!: EntityTable<MetaRow, 'key'>
  actors!: EntityTable<ActorRow, 'actorKey'>
  activities!: EntityTable<ActivityRow, 'id'>
  activityBodies!: EntityTable<ActivityBodyRow, 'activityId'>
  activityProjectionFacts!: EntityTable<ActivityProjectionFactRow, 'key'>
  activityAggregates!: EntityTable<ActivityAggregateRow, 'key'>
  activityTypeAggregates!: EntityTable<ActivityTypeAggregateRow, 'key'>
  followingSummaries!: EntityTable<FollowingSummaryRow, 'key'>
  activityProjectionState!: EntityTable<ActivityProjectionStateRow, 'key'>
  followingMembers!: Table<FollowingMemberRow, [string, string]>
  followingMemberships!: Table<FollowingMembershipRow, [string, string]>
  followingAdditions!: Table<FollowingAdditionRow, [string, string]>
  followingState!: EntityTable<FollowingStateRow, 'key'>
  filterReplicas!: EntityTable<FilterReplicaRow, 'id'>
  filters!: EntityTable<FilterRow, 'id'>
  feedState!: EntityTable<FeedStateRow, 'key'>
  outbox!: EntityTable<OutboxRow, 'mutationId'>
  syncLanes!: EntityTable<SyncLaneRow, 'scopeKey'>
  coverage!: EntityTable<CoverageRow, 'scopeKey'>
  syncState!: EntityTable<SyncStateRow, 'key'>
  syncLease!: EntityTable<SyncLeaseRow, 'key'>

  constructor(name: string) {
    super(name)
    this.version(1).stores({
      meta: '&key',
      actors: '&actorKey,githubId,normalizedLogin',
      activities:
        '&id,actorKey,type,[publishedAt+id],[actorKey+publishedAt+id],[type+publishedAt+id]',
      activityBodies: '&activityId',
      followingMembers:
        '&[snapshotRevision+actorKey],snapshotRevision,actorKey,[snapshotRevision+actorId]',
      followingState: '&key',
      filterReplicas: '&id,changedRevision,deletedAt',
      filters: '&id,deletedAt,sync',
      feedState: '&key',
      outbox: '&mutationId,localSequence,entityKey,status',
      syncLanes: '&scopeKey,kind,lastUsedAt',
      coverage: '&scopeKey',
      syncState: '&key',
      syncLease: '&key',
    })
    this.version(2)
      .stores({
        activities:
          '&id,actorKey,type,insertedRevision,[insertedRevision+id],[publishedAt+id],[actorKey+publishedAt+id],[type+publishedAt+id]',
        activityProjectionFacts:
          '&key,generation,[generation+activityId],[generation+actorKey+visible+publishedAt+activityId],[generation+actorKey+type+visible+publishedAt+activityId],[generation+type+visible+publishedAt+activityId],[generation+visible+publishedAt+activityId]',
        activityAggregates: '&key,generation,[generation+actorKey],[generation+type]',
        activityProjectionState: '&key',
      })
      .upgrade(transaction =>
        transaction
          .table<ActivityRow, string>('activities')
          .toCollection()
          .modify(activity => {
            activity.insertedRevision = normalizeInsertedRevision(activity.insertedRevision)
          }),
      )
    this.version(3)
      .stores({
        followingMembers:
          '&[snapshotRevision+actorKey],snapshotRevision,actorKey,[snapshotRevision+actorId],[snapshotRevision+normalizedLogin+actorKey]',
        followingMemberships:
          '&[snapshotRevision+actorKey],snapshotRevision,actorKey,memberActorKey',
        followingAdditions: '&[snapshotRevision+actorKey],snapshotRevision,actorKey',
        followingSummaries: '&key,generation,[generation+actorKey],[generation+sortKey+actorKey]',
        activityTypeAggregates: '&key,generation,[generation+type]',
      })
      .upgrade(async transaction => {
        const members = await transaction
          .table<FollowingMemberRow, [string, string]>('followingMembers')
          .toArray()
        for (const member of members) {
          member.normalizedLogin = member.login.toLocaleLowerCase('en-US')
        }
        await transaction
          .table<FollowingMemberRow, [string, string]>('followingMembers')
          .bulkPut(members)
        await transaction
          .table<FollowingMembershipRow, [string, string]>('followingMemberships')
          .bulkPut(
            members.flatMap(member =>
              [member.actorKey, ...member.legacyActorKeys].map(actorKey => ({
                snapshotRevision: member.snapshotRevision,
                actorKey,
                memberActorKey: member.actorKey,
              })),
            ),
          )
        const state = await transaction
          .table<FollowingStateRow, 'active'>('followingState')
          .get('active')
        if (state) {
          state.membershipSignature = null
          state.stagingRevision = null
          state.stagingCursor = null
          state.stagingComplete = false
          state.stagingFinalizeCursorActorKey = null
          state.stagingMembershipDigest = null
          state.stagingMembershipCount = 0
          await transaction.table<FollowingStateRow, 'active'>('followingState').put(state)
        }
        const projection = await transaction
          .table<ActivityProjectionStateRow, 'activity'>('activityProjectionState')
          .get('activity')
        if (projection) {
          projection.activeSignature = null
          projection.buildingGeneration = null
          projection.buildingSignature = null
          projection.buildingCursorRevision = null
          projection.buildingCursorId = null
          projection.buildingTargetRevision = null
          projection.buildingFollowingInitialized = false
          projection.buildingFollowingCursorActorKey = null
          projection.followingDisplayRevision = null
          projection.followingDisplayTargetRevision = null
          projection.followingDisplayCursorActorKey = null
          await transaction
            .table<ActivityProjectionStateRow, 'activity'>('activityProjectionState')
            .put(projection)
        }
        await transaction
          .table<SyncLaneRow, string>('syncLanes')
          .toCollection()
          .modify(lane => {
            lane.historyBudgetToken = null
            lane.historyBudgetExhausted = false
            lane.historyBudgetPageCount = 0
            lane.historyBudgetItemCount = 0
          })
      })
  }
}

export function databaseNameForOwner(ownerGithubId: string) {
  return `better-github-feed:local-feed:v1:${encodeURIComponent(ownerGithubId)}`
}

export function databaseAccountBindingIsCompatible(input: {
  storedGeneration: unknown
  storedNonce: unknown
  nextGeneration: number
  nextNonce: string
}) {
  const storedGeneration = input.storedGeneration
  if (
    typeof storedGeneration !== 'number' ||
    !Number.isSafeInteger(storedGeneration) ||
    storedGeneration < 0 ||
    !Number.isSafeInteger(input.nextGeneration) ||
    input.nextGeneration < 0 ||
    input.nextNonce.length === 0
  ) {
    return false
  }
  if (storedGeneration > input.nextGeneration) return false
  if (storedGeneration === input.nextGeneration) {
    return input.storedNonce === input.nextNonce
  }
  return (
    input.storedNonce === undefined ||
    (typeof input.storedNonce === 'string' && input.storedNonce.length > 0)
  )
}

export async function initializeDatabase(
  database: LocalFeedDatabase,
  ownerGithubId: string,
  accountGeneration: number,
  accountNonce: string,
): Promise<boolean> {
  let created = false
  await database.transaction('rw', database.meta, database.followingState, async () => {
    const storedOwner = await database.meta.get('ownerGithubId')
    if (storedOwner && storedOwner.value !== ownerGithubId) {
      throw new Error('LocalFeed database owner mismatch')
    }
    const [storedGeneration, storedNonce] = await Promise.all([
      database.meta.get('accountGeneration'),
      database.meta.get('accountGenerationNonce'),
    ])
    if (
      storedOwner &&
      !databaseAccountBindingIsCompatible({
        storedGeneration: storedGeneration?.value,
        storedNonce: storedNonce?.value,
        nextGeneration: accountGeneration,
        nextNonce: accountNonce,
      })
    ) {
      throw new Error('LocalFeed database account generation mismatch')
    }
    created = !storedOwner

    await database.meta.bulkPut([
      { key: 'ownerGithubId', value: ownerGithubId },
      { key: 'schemaVersion', value: 3 },
      { key: 'accountGeneration', value: accountGeneration },
      { key: 'accountGenerationNonce', value: accountNonce },
      ...(storedOwner ? [] : [{ key: 'localRevision', value: 0 }]),
    ])

    if (!(await database.followingState.get('active'))) {
      await database.followingState.put({
        key: 'active',
        activeRevision: null,
        stagingRevision: null,
        stagingCursor: null,
        stagingComplete: false,
        stagingFinalizeCursorActorKey: null,
        stagingMembershipDigest: null,
        stagingMembershipCount: 0,
        pendingTransition: null,
        membershipSignature: null,
      })
    }
  })
  return created
}

export async function runBoundedDatabaseDelete(
  operation: () => Promise<unknown>,
  timeoutMs = 2_000,
): Promise<'deleted' | 'pending'> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const deletion = operation().then(
    () => 'deleted' as const,
    () => 'pending' as const,
  )
  const deadline = new Promise<'pending'>(resolve => {
    timeout = setTimeout(() => resolve('pending'), timeoutMs)
  })
  const result = await Promise.race([deletion, deadline])
  if (timeout !== undefined) clearTimeout(timeout)
  return result
}

export async function assertDatabaseAccount(
  database: LocalFeedDatabase,
  ownerGithubId: string,
  accountGeneration: number,
  accountNonce: string,
) {
  const [owner, generation, nonce] = await Promise.all([
    database.meta.get('ownerGithubId'),
    database.meta.get('accountGeneration'),
    database.meta.get('accountGenerationNonce'),
  ])
  if (
    owner?.value !== ownerGithubId ||
    generation?.value !== accountGeneration ||
    nonce?.value !== accountNonce
  ) {
    throw new Error('LocalFeed database account fence is stale')
  }
}

export async function readLocalRevision(database: LocalFeedDatabase): Promise<number> {
  const row = await database.meta.get('localRevision')
  return Math.max(typeof row?.value === 'number' ? row.value : 0, database.volatileLocalRevision)
}

export async function incrementLocalRevision(database: LocalFeedDatabase): Promise<number> {
  const next = (await readLocalRevision(database)) + 1
  await database.meta.put({ key: 'localRevision', value: next })
  database.volatileLocalRevision = next
  return next
}
