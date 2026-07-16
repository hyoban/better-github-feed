import Dexie from 'dexie'

import type { ActivitySanitizerPort } from './cloud-replica'
import type {
  ActivityAggregateRow,
  ActivityBodyRow,
  ActivityProjectionStateRow,
  ActivityRow,
  ActivityTypeAggregateRow,
  FeedStateRow,
  FilterRow,
  FollowingSummaryRow,
  LocalFeedDatabase,
} from './database'
import { isHiddenByFilter } from './filter-rule'

const ACTIVITY_PROJECTION_KEY = 'activity' as const

export type ActivityClearFence = {
  publishedAt: number | null
  throughRevision: number | null
}

export function effectiveActivityClearFence(
  _feedState: Pick<
    FeedStateRow,
    'serverClearedAt' | 'optimisticClearedAt' | 'provisionalThroughRevision'
  > | null,
): ActivityClearFence {
  // Keep reading legacy replicas and outbox receipts, but manual feed clearing is retired.
  // Old watermarks must not permanently hide Activity on current clients.
  return { publishedAt: null, throughRevision: null }
}

export function isActivityCleared(
  activity: Pick<ActivityRow, 'publishedAt' | 'insertedRevision'>,
  fence: ActivityClearFence,
) {
  return (
    (fence.publishedAt !== null && activity.publishedAt <= fence.publishedAt) ||
    (fence.throughRevision !== null && activity.insertedRevision <= fence.throughRevision)
  )
}

export function upgradeActivityBodySanitization(
  body: ActivityBodyRow,
  sanitizer: ActivitySanitizerPort,
): ActivityBodyRow {
  if (body.sanitizerVersion === sanitizer.version) return body
  return {
    ...body,
    content: body.content === null ? null : sanitizer.sanitizeHtml(body.content),
    sanitizerVersion: sanitizer.version,
  }
}

function stableValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(stableValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)]),
    )
  }
  return value
}

export function activityProjectionSignature(input: {
  filters: readonly Pick<FilterRow, 'id' | 'rule' | 'deletedAt'>[]
  feedState: Pick<
    FeedStateRow,
    'serverClearedAt' | 'optimisticClearedAt' | 'provisionalThroughRevision'
  > | null
  sanitizerVersion: string
  followingMembershipSignature?: string | null
}) {
  const filters = input.filters
    .filter(filter => filter.deletedAt === null && filter.rule !== null)
    .map(filter => ({ id: filter.id, rule: filter.rule }))
    .sort((left, right) => left.id.localeCompare(right.id))
  return JSON.stringify(
    stableValue({
      clearFence: effectiveActivityClearFence(input.feedState),
      filters,
      followingMembershipSignature: input.followingMembershipSignature ?? null,
      sanitizerVersion: input.sanitizerVersion,
    }),
  )
}

function defaultState(): ActivityProjectionStateRow {
  return {
    key: ACTIVITY_PROJECTION_KEY,
    activeGeneration: null,
    activeSignature: null,
    activeThroughRevision: 0,
    buildingGeneration: null,
    buildingSignature: null,
    buildingCursorRevision: null,
    buildingCursorId: null,
    buildingTargetRevision: null,
    nextGeneration: 1,
    sanitizerVersion: null,
    garbageGenerations: [],
    buildingFollowingInitialized: false,
    buildingFollowingCursorActorKey: null,
    followingDisplayRevision: null,
    followingDisplayTargetRevision: null,
    followingDisplayCursorActorKey: null,
  }
}

function uniqueGenerations(generations: readonly number[], except: readonly (number | null)[]) {
  const excluded = new Set(except.flatMap(value => (value === null ? [] : [value])))
  return [...new Set(generations)].filter(generation => !excluded.has(generation))
}

function factKey(generation: number, activityId: string) {
  return `${generation}\u0000${activityId}`
}

function aggregateKey(generation: number, actorKey: string, type: string) {
  return `${generation}\u0000${actorKey}\u0000${type}`
}

function typeAggregateKey(generation: number, type: string) {
  return `${generation}\u0000${type}`
}

function followingSummaryKey(generation: number, actorKey: string) {
  return `${generation}\u0000${actorKey}`
}

export function followingSummarySortKey(latest: number, normalizedLogin: string) {
  const boundedLatest = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, latest))
  return `${String(Number.MAX_SAFE_INTEGER - boundedLatest).padStart(16, '0')}\u0000${normalizedLogin}`
}

function projectionSanitizerVersion(
  state: ActivityProjectionStateRow,
  storedVersion: unknown,
  sanitizer: ActivitySanitizerPort | undefined,
) {
  return (
    sanitizer?.version ??
    (typeof storedVersion === 'string' ? storedVersion : null) ??
    state.sanitizerVersion ??
    'unknown'
  )
}

export type ActivityProjectionContext = {
  state: ActivityProjectionStateRow
  signature: string
  generation: number | null
  computation: 'ready' | 'rebuilding'
  signatureMatches: boolean
  filters: readonly Pick<FilterRow, 'rule'>[]
  clearFence: ActivityClearFence
  followingRevision: string | null
}

export async function readActivityProjectionContext(
  database: LocalFeedDatabase,
  sanitizer?: ActivitySanitizerPort,
): Promise<ActivityProjectionContext> {
  const [storedState, filters, feedState, storedSanitizer, following] = await Promise.all([
    database.activityProjectionState.get(ACTIVITY_PROJECTION_KEY),
    database.filters.filter(filter => filter.deletedAt === null).toArray(),
    database.feedState.get('active'),
    database.meta.get('activitySanitizerVersion'),
    database.followingState.get('active'),
  ])
  const state = storedState ?? defaultState()
  const sanitizerVersion = projectionSanitizerVersion(state, storedSanitizer?.value, sanitizer)
  const signature = activityProjectionSignature({
    filters,
    feedState: feedState ?? null,
    sanitizerVersion,
    followingMembershipSignature: following?.membershipSignature ?? null,
  })
  const ready = state.activeGeneration !== null && state.activeSignature === signature
  return {
    state,
    signature,
    generation: state.activeGeneration,
    computation: ready && state.buildingGeneration === null ? 'ready' : 'rebuilding',
    signatureMatches: ready,
    filters,
    clearFence: effectiveActivityClearFence(feedState ?? null),
    followingRevision: following?.activeRevision ?? null,
  }
}

export function isActivityVisibleInProjection(
  activity: ActivityRow,
  body: ActivityBodyRow | undefined,
  filters: readonly Pick<FilterRow, 'rule'>[],
  clearFence: ActivityClearFence,
  followedActorKeys: ReadonlySet<string>,
) {
  return (
    followedActorKeys.has(activity.actorKey) &&
    !isActivityCleared(activity, clearFence) &&
    !isHiddenByFilter(
      {
        title: activity.title,
        repo: activity.repo,
        type: activity.type,
        summary: body?.summary ?? null,
        content: body?.content ?? null,
        githubUserLogin: activity.actorLogin,
        publishedAt: new Date(activity.publishedAt),
      },
      filters,
    )
  )
}

export type ActivityProjectionMaintenance = {
  changed: boolean
  more: boolean
  promoted: boolean
  visibleChanged: boolean
}

export function activityProjectionAccountIsCurrent(
  expected: { ownerGithubId: string; generation: number; nonce: string },
  stored: { ownerGithubId: unknown; generation: unknown; nonce: unknown },
) {
  return (
    stored.ownerGithubId === expected.ownerGithubId &&
    stored.generation === expected.generation &&
    stored.nonce === expected.nonce
  )
}

export async function maintainActivityProjection(
  database: LocalFeedDatabase,
  sanitizer?: ActivitySanitizerPort,
  batchSize = 250,
  account?: { ownerGithubId: string; generation: number; nonce: string },
): Promise<ActivityProjectionMaintenance> {
  return database.transaction(
    'rw',
    [
      database.meta,
      database.activities,
      database.activityBodies,
      database.activityProjectionFacts,
      database.activityAggregates,
      database.activityTypeAggregates,
      database.followingSummaries,
      database.activityProjectionState,
      database.filters,
      database.feedState,
      database.followingMembers,
      database.followingMemberships,
      database.followingState,
    ],
    async () => {
      const [
        storedState,
        filters,
        feedState,
        revisionRow,
        storedSanitizer,
        following,
        storedOwner,
        storedGeneration,
        storedNonce,
      ] = await Promise.all([
        database.activityProjectionState.get(ACTIVITY_PROJECTION_KEY),
        database.filters.filter(filter => filter.deletedAt === null).toArray(),
        database.feedState.get('active'),
        database.meta.get('localRevision'),
        database.meta.get('activitySanitizerVersion'),
        database.followingState.get('active'),
        account ? database.meta.get('ownerGithubId') : undefined,
        account ? database.meta.get('accountGeneration') : undefined,
        account ? database.meta.get('accountGenerationNonce') : undefined,
      ])
      if (
        account &&
        !activityProjectionAccountIsCurrent(account, {
          ownerGithubId: storedOwner?.value,
          generation: storedGeneration?.value,
          nonce: storedNonce?.value,
        })
      ) {
        throw new Error('Activity projection maintenance lost its account generation fence')
      }
      const state = storedState ?? defaultState()
      const currentRevision = typeof revisionRow?.value === 'number' ? revisionRow.value : 0
      const sanitizerVersion = projectionSanitizerVersion(state, storedSanitizer?.value, sanitizer)
      const signature = activityProjectionSignature({
        filters,
        feedState: feedState ?? null,
        sanitizerVersion,
        followingMembershipSignature: following?.membershipSignature ?? null,
      })
      let changed = storedState === undefined
      let promoted = false
      let visibleChanged = false

      if (sanitizer && storedSanitizer?.value !== sanitizer.version) {
        await database.meta.put({ key: 'activitySanitizerVersion', value: sanitizer.version })
        changed = true
      }
      state.sanitizerVersion = sanitizerVersion

      if (
        state.activeGeneration !== null &&
        state.activeSignature === signature &&
        following?.activeRevision &&
        state.followingDisplayRevision !== following.activeRevision
      ) {
        if (state.followingDisplayTargetRevision !== following.activeRevision) {
          state.followingDisplayTargetRevision = following.activeRevision
          state.followingDisplayCursorActorKey = null
        }
        const members = await database.followingMembers
          .where('[snapshotRevision+actorKey]')
          .between(
            [following.activeRevision, state.followingDisplayCursorActorKey ?? Dexie.minKey],
            [following.activeRevision, Dexie.maxKey],
            state.followingDisplayCursorActorKey === null ||
              state.followingDisplayCursorActorKey === undefined,
            true,
          )
          .limit(Math.max(1, batchSize))
          .toArray()
        if (members.length > 0) {
          const existing = await database.followingSummaries.bulkGet(
            members.map(member => followingSummaryKey(state.activeGeneration!, member.actorKey)),
          )
          const refreshed = members.map((member, index) => {
            const summary = existing[index]
            const latest = summary?.latest ?? 0
            return {
              key: followingSummaryKey(state.activeGeneration!, member.actorKey),
              generation: state.activeGeneration!,
              actorKey: member.actorKey,
              normalizedLogin: member.normalizedLogin,
              sortKey: followingSummarySortKey(latest, member.normalizedLogin),
              count: summary?.count ?? 0,
              latest,
            }
          })
          await database.followingSummaries.bulkPut(refreshed)
          state.followingDisplayCursorActorKey = members.at(-1)!.actorKey
          await database.activityProjectionState.put(state)
          return {
            changed: true,
            promoted: false,
            visibleChanged: false,
            more: true,
          }
        }
        state.followingDisplayRevision = following.activeRevision
        state.followingDisplayTargetRevision = null
        state.followingDisplayCursorActorKey = null
        changed = true
      }

      if (state.buildingGeneration !== null && state.buildingSignature !== signature) {
        if (state.buildingGeneration !== state.activeGeneration) {
          state.garbageGenerations.push(state.buildingGeneration)
        }
        state.buildingGeneration = null
        state.buildingSignature = null
        state.buildingCursorRevision = null
        state.buildingCursorId = null
        state.buildingTargetRevision = null
        state.buildingFollowingInitialized = false
        state.buildingFollowingCursorActorKey = null
        changed = true
      }

      if (state.buildingGeneration === null) {
        if (state.activeSignature !== signature || state.activeGeneration === null) {
          state.buildingGeneration = state.nextGeneration++
          state.buildingSignature = signature
          state.buildingCursorRevision = null
          state.buildingCursorId = null
          state.buildingTargetRevision = currentRevision
          state.buildingFollowingInitialized = false
          state.buildingFollowingCursorActorKey = null
          state.followingDisplayRevision = following?.activeRevision ?? null
          state.followingDisplayTargetRevision = null
          state.followingDisplayCursorActorKey = null
          changed = true
        } else if (state.activeThroughRevision < currentRevision) {
          state.buildingGeneration = state.activeGeneration
          state.buildingSignature = signature
          state.buildingCursorRevision = state.activeThroughRevision
          state.buildingCursorId = null
          state.buildingTargetRevision = currentRevision
          state.buildingFollowingInitialized = true
          state.buildingFollowingCursorActorKey = null
          changed = true
        }
      }

      if (state.buildingGeneration !== null && state.buildingTargetRevision !== null) {
        const generation = state.buildingGeneration
        const extending = generation === state.activeGeneration
        if (!state.buildingFollowingInitialized) {
          const members = following?.activeRevision
            ? await database.followingMembers
                .where('[snapshotRevision+actorKey]')
                .between(
                  [following.activeRevision, state.buildingFollowingCursorActorKey ?? Dexie.minKey],
                  [following.activeRevision, Dexie.maxKey],
                  state.buildingFollowingCursorActorKey === null ||
                    state.buildingFollowingCursorActorKey === undefined,
                  true,
                )
                .limit(Math.max(1, batchSize))
                .toArray()
            : []
          const summaries: FollowingSummaryRow[] = members.map(member => ({
            key: followingSummaryKey(generation, member.actorKey),
            generation,
            actorKey: member.actorKey,
            normalizedLogin: member.normalizedLogin,
            sortKey: followingSummarySortKey(0, member.normalizedLogin),
            count: 0,
            latest: 0,
          }))
          if (summaries.length > 0) await database.followingSummaries.bulkPut(summaries)
          changed = true
          if (members.length > 0) {
            state.buildingFollowingCursorActorKey = members.at(-1)!.actorKey
            await database.activityProjectionState.put(state)
            return {
              changed,
              promoted: false,
              visibleChanged: false,
              more: true,
            }
          }
          state.buildingFollowingInitialized = true
          state.buildingFollowingCursorActorKey = null
        }
        const lower =
          state.buildingCursorRevision === null
            ? ([Dexie.minKey, Dexie.minKey] as const)
            : state.buildingCursorId === null
              ? ([state.buildingCursorRevision, Dexie.maxKey] as const)
              : ([state.buildingCursorRevision, state.buildingCursorId] as const)
        const activities = await database.activities
          .where('[insertedRevision+id]')
          .between(
            lower,
            [state.buildingTargetRevision, Dexie.maxKey],
            !extending && state.buildingCursorRevision === null,
            true,
          )
          .limit(Math.max(1, batchSize))
          .toArray()

        if (activities.length > 0) {
          const [storedBodies, memberships] = await Promise.all([
            database.activityBodies.bulkGet(activities.map(activity => activity.id)),
            following?.activeRevision
              ? database.followingMemberships.bulkGet(
                  activities.map(activity => [following.activeRevision!, activity.actorKey]),
                )
              : Promise.resolve([]),
          ])
          const canonicalActorByActivityActor = new Map<string, string>()
          for (const [index, membership] of memberships.entries()) {
            if (membership) {
              canonicalActorByActivityActor.set(
                activities[index]!.actorKey,
                membership.memberActorKey,
              )
            }
          }
          const followedActorKeys = new Set(canonicalActorByActivityActor.keys())
          const migratedBodies: ActivityBodyRow[] = []
          const bodies = storedBodies.map(body => {
            if (!body || !sanitizer || body.sanitizerVersion === sanitizer.version) return body
            const migrated = upgradeActivityBodySanitization(body, sanitizer)
            migratedBodies.push(migrated)
            return migrated
          })
          const clearFence = effectiveActivityClearFence(feedState ?? null)
          const facts = activities.map((activity, index) => ({
            key: factKey(generation, activity.id),
            generation,
            activityId: activity.id,
            actorKey: activity.actorKey,
            type: activity.type,
            publishedAt: activity.publishedAt,
            visible: isActivityVisibleInProjection(
              activity,
              bodies[index],
              filters,
              clearFence,
              followedActorKeys,
            )
              ? (1 as const)
              : (0 as const),
          }))
          const aggregateDeltas = new Map<
            string,
            { actorKey: string; type: string; count: number; latest: number }
          >()
          const typeDeltas = new Map<string, { type: string; count: number }>()
          const followingDeltas = new Map<
            string,
            { actorKey: string; count: number; latest: number }
          >()
          for (const fact of facts) {
            if (fact.visible === 0) continue
            const key = aggregateKey(generation, fact.actorKey, fact.type)
            const current = aggregateDeltas.get(key)
            aggregateDeltas.set(key, {
              actorKey: fact.actorKey,
              type: fact.type,
              count: (current?.count ?? 0) + 1,
              latest: Math.max(current?.latest ?? fact.publishedAt, fact.publishedAt),
            })
            const typeKey = typeAggregateKey(generation, fact.type)
            const currentType = typeDeltas.get(typeKey)
            typeDeltas.set(typeKey, {
              type: fact.type,
              count: (currentType?.count ?? 0) + 1,
            })
            const canonicalActorKey = canonicalActorByActivityActor.get(fact.actorKey)!
            const summaryKey = followingSummaryKey(generation, canonicalActorKey)
            const currentSummary = followingDeltas.get(summaryKey)
            followingDeltas.set(summaryKey, {
              actorKey: canonicalActorKey,
              count: (currentSummary?.count ?? 0) + 1,
              latest: Math.max(currentSummary?.latest ?? fact.publishedAt, fact.publishedAt),
            })
          }
          const deltaEntries = [...aggregateDeltas.entries()]
          const typeDeltaEntries = [...typeDeltas.entries()]
          const followingDeltaEntries = [...followingDeltas.entries()]
          const [existingAggregates, existingTypeAggregates, existingFollowingSummaries] =
            await Promise.all([
              database.activityAggregates.bulkGet(deltaEntries.map(([key]) => key)),
              database.activityTypeAggregates.bulkGet(typeDeltaEntries.map(([key]) => key)),
              database.followingSummaries.bulkGet(followingDeltaEntries.map(([key]) => key)),
            ])
          const aggregates: ActivityAggregateRow[] = deltaEntries.map(([key, delta], index) => ({
            key,
            generation,
            actorKey: delta.actorKey,
            type: delta.type,
            count: (existingAggregates[index]?.count ?? 0) + delta.count,
            latest: Math.max(existingAggregates[index]?.latest ?? delta.latest, delta.latest),
          }))
          const typeAggregates: ActivityTypeAggregateRow[] = typeDeltaEntries.map(
            ([key, delta], index) => ({
              key,
              generation,
              type: delta.type,
              count: (existingTypeAggregates[index]?.count ?? 0) + delta.count,
            }),
          )
          const followingSummaries: FollowingSummaryRow[] = followingDeltaEntries.map(
            ([key, delta], index) => {
              const existing = existingFollowingSummaries[index]
              const latest = Math.max(existing?.latest ?? delta.latest, delta.latest)
              const normalizedLogin = existing?.normalizedLogin ?? ''
              return {
                key,
                generation,
                actorKey: delta.actorKey,
                normalizedLogin,
                sortKey: followingSummarySortKey(latest, normalizedLogin),
                count: (existing?.count ?? 0) + delta.count,
                latest,
              }
            },
          )
          await Promise.all([
            database.activityProjectionFacts.bulkPut(facts),
            aggregates.length > 0 ? database.activityAggregates.bulkPut(aggregates) : undefined,
            typeAggregates.length > 0
              ? database.activityTypeAggregates.bulkPut(typeAggregates)
              : undefined,
            followingSummaries.length > 0
              ? database.followingSummaries.bulkPut(followingSummaries)
              : undefined,
            migratedBodies.length > 0 ? database.activityBodies.bulkPut(migratedBodies) : undefined,
          ])
          const last = activities.at(-1)!
          state.buildingCursorRevision = last.insertedRevision
          state.buildingCursorId = last.id
          changed = true
          visibleChanged = extending
        } else {
          const previousActive = state.activeGeneration
          state.activeGeneration = generation
          state.activeSignature = signature
          state.activeThroughRevision = state.buildingTargetRevision
          state.buildingGeneration = null
          state.buildingSignature = null
          state.buildingCursorRevision = null
          state.buildingCursorId = null
          state.buildingTargetRevision = null
          state.buildingFollowingInitialized = false
          state.buildingFollowingCursorActorKey = null
          if (previousActive !== null && previousActive !== generation) {
            state.garbageGenerations.push(previousActive)
          }
          changed = true
          promoted = true
          visibleChanged = true
        }
      }

      state.garbageGenerations = uniqueGenerations(state.garbageGenerations, [
        state.activeGeneration,
        state.buildingGeneration,
      ])
      if (state.buildingGeneration === null && state.garbageGenerations.length > 0) {
        const garbage = state.garbageGenerations[0]!
        const factKeys = await database.activityProjectionFacts
          .where('generation')
          .equals(garbage)
          .limit(Math.max(1, batchSize))
          .primaryKeys()
        if (factKeys.length > 0) {
          await database.activityProjectionFacts.bulkDelete(factKeys)
        } else {
          await Promise.all([
            database.activityAggregates.where('generation').equals(garbage).delete(),
            database.activityTypeAggregates.where('generation').equals(garbage).delete(),
            database.followingSummaries.where('generation').equals(garbage).delete(),
          ])
          state.garbageGenerations.shift()
        }
        changed = true
      }

      await database.activityProjectionState.put(state)
      return {
        changed,
        promoted,
        visibleChanged,
        more:
          state.buildingGeneration !== null ||
          state.garbageGenerations.length > 0 ||
          state.activeThroughRevision < currentRevision,
      }
    },
  )
}
