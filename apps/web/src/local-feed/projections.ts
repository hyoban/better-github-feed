import Dexie from 'dexie'

import { isValidActivityProjectionId } from './activity-id'
import {
  isActivityVisibleInProjection,
  readActivityProjectionContext,
  upgradeActivityBodySanitization,
} from './activity-projection'
import type { ActivitySanitizerPort } from './cloud-replica'
import type {
  ActivityAggregateRow,
  ActivityProjectionFactRow,
  FollowingMemberRow,
  FollowingSummaryRow,
  LocalFeedDatabase,
} from './database'
import { readLocalRevision } from './database'
import { readAuthorizedActorSelection, readFollowedActorKeys } from './following-membership'
import type {
  ActivityResult,
  ActivitySummary,
  FeedView,
  FollowingSummary,
  LocalFeedStatistics,
  LocalSyncStatus,
  LocalUserFilter,
  Projection,
  ProjectionOutput,
  RawAtomActivity,
  VisibleFeedWindow,
} from './types'

type ProjectionRead<T> = { localRevision: number; value: T }

export function activityFactQueryPlan(
  actors: FeedView['actors'],
  types: FeedView['types'],
): 'actor' | 'actor-type-aggregated' | 'following-type' | 'following' {
  if (actors === 'following') return types === 'all' ? 'following' : 'following-type'
  if (types === 'all') return 'actor'
  return 'actor-type-aggregated'
}

type ActivityFactCursor = Pick<ActivityProjectionFactRow, 'publishedAt' | 'activityId'>
export type ActivityFactLaneReader = (
  before: ActivityFactCursor | null,
  limit: number,
) => Promise<ActivityProjectionFactRow[]>

function compareActivityFacts(left: ActivityFactCursor, right: ActivityFactCursor) {
  return right.publishedAt - left.publishedAt || right.activityId.localeCompare(left.activityId)
}

export function selectActivityAggregateLanes<
  Row extends Pick<ActivityAggregateRow, 'actorKey' | 'type' | 'count' | 'latest'>,
>(rows: readonly Row[], limit: number): Row[] {
  if (limit <= 0) return []
  const eligible = rows
    .filter(row => row.count > 0)
    .sort(
      (left, right) =>
        right.latest - left.latest ||
        left.actorKey.localeCompare(right.actorKey) ||
        left.type.localeCompare(right.type),
    )
  const cutoff = eligible[Math.min(limit, eligible.length) - 1]?.latest
  return cutoff === undefined ? [] : eligible.filter(row => row.latest >= cutoff)
}

export async function readNewestActivityFacts(
  readers: readonly ActivityFactLaneReader[],
  limit: number,
  batchSize = 32,
) {
  if (limit <= 0 || readers.length === 0) return []
  const size = Math.max(1, Math.min(batchSize, limit))
  const lanes = readers.map(reader => ({
    reader,
    buffer: [] as ActivityProjectionFactRow[],
    cursor: null as ActivityFactCursor | null,
    exhausted: false,
  }))
  const refill = async (index: number, requestedSize = size) => {
    const lane = lanes[index]!
    if (lane.exhausted || lane.buffer.length > 0) return
    const rows = await lane.reader(lane.cursor, requestedSize)
    lane.buffer.push(...rows)
    if (rows.length > 0) lane.cursor = rows.at(-1)!
    if (rows.length < requestedSize) lane.exhausted = true
  }
  for (let index = 0; index < lanes.length; index += 64) {
    await Promise.all(lanes.slice(index, index + 64).map((_, offset) => refill(index + offset, 1)))
  }

  const result: ActivityProjectionFactRow[] = []
  while (result.length < limit) {
    let newestLane = -1
    for (const [index, lane] of lanes.entries()) {
      const head = lane.buffer[0]
      if (!head) continue
      const newest = newestLane === -1 ? undefined : lanes[newestLane]!.buffer[0]
      if (!newest || compareActivityFacts(head, newest) < 0) newestLane = index
    }
    if (newestLane === -1) break
    result.push(lanes[newestLane]!.buffer.shift()!)
    await refill(newestLane)
  }
  return result
}

function scopeKey(actors: FeedView['actors'], followingRevision: string | null) {
  return actors === 'following' || actors.length > 250
    ? `following:${followingRevision ?? 'none'}`
    : `actors:${JSON.stringify([...actors].sort())}`
}

async function readActivityCandidates(
  database: LocalFeedDatabase,
  actors: FeedView['actors'],
  first: number,
  types: FeedView['types'],
  sanitizer?: ActivitySanitizerPort,
) {
  const following = await database.followingState.get('active')
  const selection =
    actors === 'following'
      ? null
      : following?.activeRevision
        ? await readAuthorizedActorSelection(database, following.activeRevision, actors)
        : { actorKeys: [], rejectedActorKeys: [...new Set(actors)] }
  const rejectedActorKeys = selection?.rejectedActorKeys ?? []
  const authorized = selection ? new Set(selection.actorKeys) : null

  const projectionContext = await readActivityProjectionContext(database, sanitizer)

  const target = first + 1
  const candidateLimit = projectionContext.signatureMatches
    ? target
    : target + Math.min(500, target * 3)
  const requestedTypes = types === 'all' ? null : new Set(types)
  const generation = projectionContext.generation
  let facts: ActivityProjectionFactRow[] = []
  if (generation !== null && (authorized === null || authorized.size > 0)) {
    const actorKeys = authorized ? [...authorized] : []
    const typeKeys = requestedTypes ? [...requestedTypes] : []
    const queryPlan = activityFactQueryPlan(
      actors === 'following' ? 'following' : (actorKeys as [string, ...string[]]),
      types,
    )
    const actorLane =
      (actorKey: string): ActivityFactLaneReader =>
      (before, limit) =>
        database.activityProjectionFacts
          .where('[generation+actorKey+visible+publishedAt+activityId]')
          .between(
            [generation, actorKey, 1, Dexie.minKey, Dexie.minKey],
            [
              generation,
              actorKey,
              1,
              before?.publishedAt ?? Dexie.maxKey,
              before?.activityId ?? Dexie.maxKey,
            ],
            true,
            before === null,
          )
          .reverse()
          .limit(limit)
          .toArray()
    const typeLane =
      (type: string): ActivityFactLaneReader =>
      (before, limit) =>
        database.activityProjectionFacts
          .where('[generation+type+visible+publishedAt+activityId]')
          .between(
            [generation, type, 1, Dexie.minKey, Dexie.minKey],
            [
              generation,
              type,
              1,
              before?.publishedAt ?? Dexie.maxKey,
              before?.activityId ?? Dexie.maxKey,
            ],
            true,
            before === null,
          )
          .reverse()
          .limit(limit)
          .toArray()
    let readers: ActivityFactLaneReader[]
    if (queryPlan === 'actor') {
      readers = actorKeys.map(actorLane)
    } else if (queryPlan === 'actor-type-aggregated') {
      const aggregates: ActivityAggregateRow[] = []
      for (let index = 0; index < actorKeys.length; index += 64) {
        const batch = await Promise.all(
          actorKeys
            .slice(index, index + 64)
            .map(actorKey =>
              database.activityAggregates
                .where('[generation+actorKey]')
                .equals([generation, actorKey])
                .toArray(),
            ),
        )
        aggregates.push(...batch.flat().filter(aggregate => requestedTypes!.has(aggregate.type)))
      }
      readers = selectActivityAggregateLanes(aggregates, candidateLimit).map(
        ({ actorKey, type }) =>
          (before: ActivityFactCursor | null, limit: number) =>
            database.activityProjectionFacts
              .where('[generation+actorKey+type+visible+publishedAt+activityId]')
              .between(
                [generation, actorKey, type, 1, Dexie.minKey, Dexie.minKey],
                [
                  generation,
                  actorKey,
                  type,
                  1,
                  before?.publishedAt ?? Dexie.maxKey,
                  before?.activityId ?? Dexie.maxKey,
                ],
                true,
                before === null,
              )
              .reverse()
              .limit(limit)
              .toArray(),
      )
    } else if (queryPlan === 'following-type') {
      readers = typeKeys.map(typeLane)
    } else {
      readers = [
        (before, limit) =>
          database.activityProjectionFacts
            .where('[generation+visible+publishedAt+activityId]')
            .between(
              [generation, 1, Dexie.minKey, Dexie.minKey],
              [
                generation,
                1,
                before?.publishedAt ?? Dexie.maxKey,
                before?.activityId ?? Dexie.maxKey,
              ],
              true,
              before === null,
            )
            .reverse()
            .limit(limit)
            .toArray(),
      ]
    }
    facts = await readNewestActivityFacts(readers, candidateLimit)
  }
  const uniqueFacts = new Map<string, ActivityProjectionFactRow>()
  for (const fact of facts) {
    if (
      (authorized === null || authorized.has(fact.actorKey)) &&
      (requestedTypes === null || requestedTypes.has(fact.type))
    ) {
      uniqueFacts.set(fact.activityId, fact)
    }
  }
  const selectedFacts = [...uniqueFacts.values()]
  const [activityRows, bodies, actorRows, followedFactActorKeys] = await Promise.all([
    database.activities.bulkGet(selectedFacts.map(fact => fact.activityId)),
    database.activityBodies.bulkGet(selectedFacts.map(fact => fact.activityId)),
    database.actors.bulkGet([...new Set(selectedFacts.map(fact => fact.actorKey))]),
    following?.activeRevision
      ? readFollowedActorKeys(
          database,
          following.activeRevision,
          selectedFacts.map(fact => fact.actorKey),
        )
      : Promise.resolve(new Set<string>()),
  ])
  const actorByKey = new Map(
    actorRows.flatMap(actor => (actor ? [[actor.actorKey, actor] as const] : [])),
  )
  const visible: ActivitySummary[] = activityRows.flatMap((row, index) => {
    if (!row) return []
    const storedBody = bodies[index]
    const body =
      storedBody && sanitizer ? upgradeActivityBodySanitization(storedBody, sanitizer) : storedBody
    if (
      !isActivityVisibleInProjection(
        row,
        body,
        projectionContext.filters,
        projectionContext.clearFence,
        followedFactActorKeys,
      )
    ) {
      return []
    }
    const actor = actorByKey.get(row.actorKey)
    return [
      {
        id: row.id,
        actorKey: row.actorKey,
        actor: row.actorLogin,
        actorGithubId: actor?.githubId ?? null,
        actorAvatarUrl: actor?.avatarUrl ?? null,
        title: row.title,
        link: row.link,
        repo: row.repo,
        type: row.type,
        publishedAt: row.publishedAt,
        summary: body?.summary ?? null,
        source: row.source,
      },
    ]
  })

  return {
    visible,
    rejectedActorKeys,
    followingRevision: following?.activeRevision ?? null,
    projectionContext,
    coverageActors:
      actors === 'following'
        ? ('following' as const)
        : (selection!.actorKeys as [string, ...string[]]),
  }
}

async function readVisibleFeed(
  database: LocalFeedDatabase,
  view: FeedView,
  first: number,
  sanitizer?: ActivitySanitizerPort,
): Promise<VisibleFeedWindow> {
  const candidates = await readActivityCandidates(
    database,
    view.actors,
    first,
    view.types,
    sanitizer,
  )
  const typed = candidates.visible
  const coverage = await database.coverage.get(
    scopeKey(candidates.coverageActors, candidates.followingRevision),
  )
  const hasMoreLocal = typed.length > first
  const remoteWindow = coverage?.remoteWindow ?? 'unchecked'

  return {
    items: typed.slice(0, first),
    rejectedActorKeys: candidates.rejectedActorKeys,
    coverage: {
      bootstrap: coverage?.bootstrap ?? 'never-synced',
      demand:
        candidates.projectionContext.computation === 'ready' &&
        coverage?.bootstrap === 'initialized' &&
        (typed.length >= first || remoteWindow === 'exhausted')
          ? 'satisfied'
          : 'insufficient',
      hasMoreLocal,
      remoteWindow,
      integrity: coverage?.integrity ?? 'continuous',
    },
    computation: candidates.projectionContext.computation,
  }
}

async function readFollowing(
  database: LocalFeedDatabase,
  sort: 'latest' | 'name',
  first: number,
  sanitizer?: ActivitySanitizerPort,
) {
  const [following, projectionContext] = await Promise.all([
    database.followingState.get('active'),
    readActivityProjectionContext(database, sanitizer),
  ])
  const revision = following?.activeRevision ?? null
  if (revision === null) {
    return {
      items: [] as FollowingSummary[],
      totalLocal: 0,
      coverage: {
        bootstrap: 'never-synced' as const,
        demand: 'satisfied' as const,
        hasMoreLocal: false,
        remoteWindow: 'unchecked' as const,
        integrity: 'continuous' as const,
      },
      computation: projectionContext.computation,
    }
  }

  const generation =
    projectionContext.signatureMatches &&
    projectionContext.generation !== null &&
    projectionContext.state.followingDisplayRevision === revision
      ? projectionContext.generation
      : null
  const computation = generation === null ? ('rebuilding' as const) : projectionContext.computation
  const totalLocal = await database.followingMembers
    .where('snapshotRevision')
    .equals(revision)
    .count()
  let members: FollowingMemberRow[]
  let summaries: (FollowingSummaryRow | undefined)[]
  if (sort === 'latest' && generation !== null) {
    const orderedSummaries = await database.followingSummaries
      .where('[generation+sortKey+actorKey]')
      .between(
        [generation, Dexie.minKey, Dexie.minKey],
        [generation, Dexie.maxKey, Dexie.maxKey],
        true,
        true,
      )
      .limit(first + 1)
      .toArray()
    const storedMembers = await database.followingMembers.bulkGet(
      orderedSummaries.map(summary => [revision, summary.actorKey]),
    )
    const present = orderedSummaries.flatMap((summary, index) => {
      const member = storedMembers[index]
      return member ? [{ member, summary }] : []
    })
    members = present.map(entry => entry.member)
    summaries = present.map(entry => entry.summary)
  } else {
    members = await database.followingMembers
      .where('[snapshotRevision+normalizedLogin+actorKey]')
      .between(
        [revision, Dexie.minKey, Dexie.minKey],
        [revision, Dexie.maxKey, Dexie.maxKey],
        true,
        true,
      )
      .limit(first + 1)
      .toArray()
    summaries =
      generation === null
        ? members.map(() => undefined)
        : await database.followingSummaries.bulkGet(
            members.map(member => `${generation}\u0000${member.actorKey}`),
          )
  }
  const actorRows = await database.actors.bulkGet(members.map(member => member.actorKey))
  const actorByKey = new Map(
    actorRows.flatMap(actor => (actor ? [[actor.actorKey, actor] as const] : [])),
  )
  const items: FollowingSummary[] = members.map((member, index) => {
    const actor = actorByKey.get(member.actorKey)
    const stats = summaries[index]
    return {
      actorKey: member.actorKey,
      githubId: actor?.githubId ?? member.actorId,
      login: actor?.login ?? member.login,
      avatarUrl: actor?.avatarUrl ?? member.avatarUrl ?? null,
      followedAt: member.followedAt,
      itemCount: stats?.count ?? 0,
      latestEntryAt: stats && stats.latest > 0 ? stats.latest : null,
    }
  })
  return {
    items: items.slice(0, first),
    totalLocal,
    coverage: {
      bootstrap: following?.activeRevision ? ('initialized' as const) : ('never-synced' as const),
      demand: 'satisfied' as const,
      hasMoreLocal: totalLocal > first,
      remoteWindow: 'exhausted' as const,
      integrity: 'continuous' as const,
    },
    computation,
  }
}

async function readActivity(
  database: LocalFeedDatabase,
  id: string,
  sanitizer?: ActivitySanitizerPort,
): Promise<ActivityResult> {
  if (!isValidActivityProjectionId(id)) {
    return { kind: 'cloud-miss', reason: 'not-retained-or-unknown' }
  }
  const [row, body, resolution] = await Promise.all([
    database.activities.get(id),
    database.activityBodies.get(id),
    database.syncState.get(`activity:${id}`),
  ])
  if (!row) {
    switch (resolution?.activityResult) {
      case 'resolving':
        return { kind: 'resolving' }
      case 'cloud-unavailable':
        return { kind: 'cloud-unavailable' }
      case 'not-authorized':
        return { kind: 'not-authorized' }
      case 'cloud-miss':
        return { kind: 'cloud-miss', reason: 'not-retained-or-unknown' }
      default:
        return { kind: 'unavailable-offline' }
    }
  }
  const actor = await database.actors.get(row.actorKey)
  const activity: RawAtomActivity = {
    id: row.id,
    actorKey: row.actorKey,
    actor: row.actorLogin,
    actorGithubId: actor?.githubId ?? null,
    actorAvatarUrl: actor?.avatarUrl ?? null,
    title: row.title,
    link: row.link,
    repo: row.repo,
    type: row.type,
    publishedAt: row.publishedAt,
    summary: body?.summary ?? null,
    content:
      body?.content === null || body?.content === undefined
        ? null
        : sanitizer && body.sanitizerVersion !== sanitizer.version
          ? sanitizer.sanitizeHtml(body.content)
          : body.content,
    source: row.source,
  }
  return { kind: 'available', activity }
}

async function readFilters(database: LocalFeedDatabase): Promise<readonly LocalUserFilter[]> {
  const rows = await database.filters.filter(filter => filter.deletedAt === null).sortBy('name')
  return rows.map(filter => ({
    id: filter.id,
    name: filter.name,
    sync: filter.sync,
    ...(filter.rule
      ? { isValid: true as const, rule: filter.rule }
      : {
          isValid: false as const,
          rule: null,
          issue: 'invalid-legacy-rule' as const,
        }),
  }))
}

async function readStatistics(
  database: LocalFeedDatabase,
  actors: FeedView['actors'],
  sanitizer?: ActivitySanitizerPort,
): Promise<LocalFeedStatistics> {
  const following = await database.followingState.get('active')
  const authorized =
    actors === 'following' || !following?.activeRevision
      ? []
      : (await readAuthorizedActorSelection(database, following.activeRevision, actors)).actorKeys
  const projectionContext = await readActivityProjectionContext(database, sanitizer)
  const typeCounts: Record<string, number> = {}
  if (projectionContext.generation !== null && projectionContext.signatureMatches) {
    if (actors === 'following') {
      const aggregates = await database.activityTypeAggregates
        .where('generation')
        .equals(projectionContext.generation)
        .toArray()
      for (const aggregate of aggregates) typeCounts[aggregate.type] = aggregate.count
    } else {
      const aggregates = (
        await Promise.all(
          authorized.map(actorKey =>
            database.activityAggregates
              .where('[generation+actorKey]')
              .equals([projectionContext.generation!, actorKey])
              .toArray(),
          ),
        )
      ).flat()
      for (const aggregate of aggregates) {
        typeCounts[aggregate.type] = (typeCounts[aggregate.type] ?? 0) + aggregate.count
      }
    }
  }
  const coverageActors =
    actors === 'following' ? ('following' as const) : (authorized as [string, ...string[]])
  const coverage = await database.coverage.get(
    scopeKey(coverageActors, following?.activeRevision ?? null),
  )
  return {
    typeCounts,
    coverage:
      projectionContext.computation === 'ready' && coverage?.remoteWindow === 'exhausted'
        ? 'complete-for-demand'
        : 'partial',
    computation: projectionContext.computation,
  }
}

async function readSyncStatus(database: LocalFeedDatabase): Promise<LocalSyncStatus> {
  const [state, pendingUserOperations] = await Promise.all([
    database.syncState.get('status'),
    // Blocked conflict copies remain local-only user data and are also at risk on deletion.
    database.outbox.count(),
  ])
  return {
    ...(database.volatileSyncStatus ?? state?.status ?? { kind: 'quiet' as const }),
    pendingUserOperations,
    ...(state?.lastCloudContactAt ? { lastCloudContactAt: state.lastCloudContactAt } : {}),
  }
}

export async function readProjection<P extends Projection>(
  database: LocalFeedDatabase,
  projection: P,
  sanitizer?: ActivitySanitizerPort,
): Promise<ProjectionRead<ProjectionOutput<P>>> {
  return database.transaction(
    'r',
    [
      database.meta,
      database.actors,
      database.activities,
      database.activityBodies,
      database.activityProjectionFacts,
      database.activityAggregates,
      database.activityTypeAggregates,
      database.followingSummaries,
      database.activityProjectionState,
      database.followingMembers,
      database.followingMemberships,
      database.followingState,
      database.filters,
      database.feedState,
      database.coverage,
      database.syncState,
      database.outbox,
    ],
    async () => {
      const value = await (async () => {
        switch (projection.kind) {
          case 'following':
            return readFollowing(database, projection.sort, projection.first, sanitizer)
          case 'visible-feed':
            return readVisibleFeed(database, projection.view, projection.first, sanitizer)
          case 'activity':
            return readActivity(database, projection.id, sanitizer)
          case 'user-filters':
            return readFilters(database)
          case 'statistics':
            return readStatistics(database, projection.actors, sanitizer)
          case 'sync-status':
            return readSyncStatus(database)
        }
      })()
      return {
        localRevision: await readLocalRevision(database),
        value: value as ProjectionOutput<P>,
      }
    },
  )
}

export function activityScopeKey(actors: FeedView['actors'], followingRevision: string | null) {
  return scopeKey(actors, followingRevision)
}

export function aggregateFollowingActivityStats(
  members: readonly Pick<FollowingMemberRow, 'actorKey' | 'legacyActorKeys'>[],
  activities: readonly Pick<ActivitySummary, 'actorKey' | 'publishedAt'>[],
) {
  const canonicalByActorKey = new Map(
    members.flatMap(member =>
      [member.actorKey, ...member.legacyActorKeys].map(
        actorKey => [actorKey, member.actorKey] as const,
      ),
    ),
  )
  const counts = new Map<string, { count: number; latest: number | null }>()
  for (const activity of activities) {
    const canonicalActorKey = canonicalByActorKey.get(activity.actorKey) ?? activity.actorKey
    const current = counts.get(canonicalActorKey) ?? { count: 0, latest: null }
    current.count += 1
    current.latest = Math.max(current.latest ?? activity.publishedAt, activity.publishedAt)
    counts.set(canonicalActorKey, current)
  }
  return counts
}

export function aggregateFollowingAggregates(
  members: readonly Pick<FollowingMemberRow, 'actorKey' | 'legacyActorKeys'>[],
  aggregates: readonly Pick<ActivityAggregateRow, 'actorKey' | 'count' | 'latest'>[],
) {
  const canonicalByActorKey = new Map(
    members.flatMap(member =>
      [member.actorKey, ...member.legacyActorKeys].map(
        actorKey => [actorKey, member.actorKey] as const,
      ),
    ),
  )
  const counts = new Map<string, { count: number; latest: number | null }>()
  for (const aggregate of aggregates) {
    const canonicalActorKey = canonicalByActorKey.get(aggregate.actorKey)
    if (!canonicalActorKey) continue
    const current = counts.get(canonicalActorKey) ?? { count: 0, latest: null }
    current.count += aggregate.count
    current.latest = Math.max(current.latest ?? aggregate.latest, aggregate.latest)
    counts.set(canonicalActorKey, current)
  }
  return counts
}
