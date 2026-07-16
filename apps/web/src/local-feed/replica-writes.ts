import type {
  ActivityDeltaPage,
  ActivityHistoryPage,
  ActivitySanitizerPort,
  FollowingPage,
  RemoteAtomActivity,
} from './cloud-replica'
import Dexie from 'dexie'
import { incrementLocalRevision } from './database'
import type {
  ActivityBodyRow,
  ActivityRow,
  ActorRow,
  FollowingAdditionRow,
  FollowingMemberRow,
  FollowingMembershipRow,
  LocalFeedDatabase,
  SyncLaneRow,
} from './database'
import {
  digestFollowingMembershipPage,
  followingMembershipSignatureFromDigest,
  mergeFollowingMembershipDigests,
  promoteFollowingSnapshot,
} from './following-transition'
import { assertTransactionLeadership } from './tab-coordinator'
import type { LeadershipFence } from './tab-coordinator'

export function compareDecimalSequence(left: string, right: string) {
  if (!/^\d+$/.test(left) || !/^\d+$/.test(right)) {
    throw new RangeError('Invalid decimal sequence')
  }
  const normalizedLeft = left.replace(/^0+(?=\d)/, '')
  const normalizedRight = right.replace(/^0+(?=\d)/, '')
  if (normalizedLeft.length !== normalizedRight.length) {
    return normalizedLeft.length < normalizedRight.length ? -1 : 1
  }
  return normalizedLeft === normalizedRight ? 0 : normalizedLeft < normalizedRight ? -1 : 1
}

const MAX_HISTORY_BUDGET_PAGES = 5
const MAX_HISTORY_BUDGET_ITEMS = 500

export function activityHistoryBudgetIsExhausted(
  lane: Pick<
    SyncLaneRow,
    'historyBudgetPageCount' | 'historyBudgetItemCount' | 'historyBudgetExhausted'
  >,
) {
  return (
    lane.historyBudgetExhausted ||
    lane.historyBudgetPageCount >= MAX_HISTORY_BUDGET_PAGES ||
    lane.historyBudgetItemCount >= MAX_HISTORY_BUDGET_ITEMS
  )
}

function assertViewer(viewerGithubId: string, ownerGithubId: string) {
  if (viewerGithubId !== ownerGithubId) throw new Error('Cloud replica viewer mismatch')
}

function validateActivity(activity: RemoteAtomActivity) {
  if (
    !activity.id ||
    !activity.actorKey ||
    !activity.actorLogin ||
    activity.source !== 'github-atom-v1' ||
    !Number.isSafeInteger(activity.publishedAtMs) ||
    Number.isNaN(Date.parse(activity.publishedAt))
  ) {
    throw new Error('Invalid remote Atom Activity')
  }
}

async function materializeActivities(
  database: LocalFeedDatabase,
  activities: readonly RemoteAtomActivity[],
  sanitizer: ActivitySanitizerPort,
  localRevision: number,
) {
  for (const activity of activities) validateActivity(activity)
  const existing = await database.activities.bulkGet(activities.map(activity => activity.id))
  const actorKeys = [...new Set(activities.map(activity => activity.actorKey))]
  const existingActors = await database.actors.bulkGet(actorKeys)
  const actors = planActivityActorRows(
    existingActors.flatMap(actor => (actor ? [actor] : [])),
    activities,
  )
  const rows: ActivityRow[] = activities.map((activity, index) => ({
    id: activity.id,
    actorKey: activity.actorKey,
    actorLogin: activity.actorLogin,
    title: activity.title,
    link: activity.link,
    repo: activity.repo,
    type: activity.type,
    publishedAt: activity.publishedAtMs,
    source: activity.source,
    insertedRevision: existing[index]?.insertedRevision ?? localRevision,
  }))
  const bodies: ActivityBodyRow[] = activities.map(activity => ({
    activityId: activity.id,
    summary: activity.summary,
    content: activity.content === null ? null : sanitizer.sanitizeHtml(activity.content),
    sanitizerVersion: sanitizer.version,
  }))

  await Promise.all([
    database.meta.put({ key: 'activitySanitizerVersion', value: sanitizer.version }),
    database.actors.bulkPut(actors),
    database.activities.bulkPut(rows),
    database.activityBodies.bulkPut(bodies),
  ])
}

export function planActivityActorRows(
  existingActors: readonly ActorRow[],
  activities: readonly RemoteAtomActivity[],
): ActorRow[] {
  const existingByKey = new Map(existingActors.map(actor => [actor.actorKey, actor]))
  const firstActivityByActor = new Map<string, RemoteAtomActivity>()
  for (const activity of activities) {
    if (!firstActivityByActor.has(activity.actorKey)) {
      firstActivityByActor.set(activity.actorKey, activity)
    }
  }

  return [...firstActivityByActor.values()].flatMap(activity => {
    const existing = existingByKey.get(activity.actorKey)
    // A Following snapshot is the current presentation authority. Historical Activity may
    // only create an actor or resolve a previously unknown numeric identity.
    if (existing && (existing.githubId !== null || activity.actorGithubId === null)) {
      return []
    }
    return [
      {
        actorKey: activity.actorKey,
        githubId: activity.actorGithubId ?? existing?.githubId ?? null,
        login: activity.actorLogin,
        normalizedLogin: activity.actorLogin.toLocaleLowerCase('en-US'),
        avatarUrl: existing?.avatarUrl ?? null,
      },
    ]
  })
}

export function planFollowingActorRows(
  existingActors: readonly (ActorRow | undefined)[],
  members: readonly Pick<
    FollowingMemberRow,
    'actorKey' | 'actorId' | 'login' | 'avatarUrl' | 'legacyActorKeys'
  >[],
): ActorRow[] {
  const inputs = members.flatMap(member => [
    { actorKey: member.actorKey, member },
    ...member.legacyActorKeys.map(actorKey => ({ actorKey, member })),
  ])
  return inputs.map(({ actorKey, member }, index) => ({
    actorKey,
    githubId: member.actorId,
    login: member.login,
    normalizedLogin: member.login.toLocaleLowerCase('en-US'),
    avatarUrl: member.avatarUrl ?? existingActors[index]?.avatarUrl ?? null,
  }))
}

function newLane(scopeKey: string, now: number): SyncLaneRow {
  return {
    scopeKey,
    kind: 'activity',
    remoteScopeKey: null,
    stableThroughSeq: null,
    historyThroughSeq: null,
    historyCursor: null,
    historyRetentionFingerprint: null,
    checkpointAfterHistory: false,
    historyBudgetToken: null,
    historyBudgetExhausted: false,
    historyBudgetPageCount: 0,
    historyBudgetItemCount: 0,
    deltaThroughSeq: null,
    deltaCursor: null,
    deltaRetentionFingerprint: null,
    lastUsedAt: now,
  }
}

export async function commitHistoryPage(input: {
  database: LocalFeedDatabase
  ownerGithubId: string
  localScopeKey: string
  expectedCursor: string | null
  page: ActivityHistoryPage
  sanitizer: ActivitySanitizerPort
  now: number
  historyBudgetToken: string | null
  fence: LeadershipFence
}) {
  const { database, page } = input
  assertViewer(page.viewerGithubId, input.ownerGithubId)

  return database.transaction(
    'rw',
    [
      database.meta,
      database.actors,
      database.activities,
      database.activityBodies,
      database.syncLanes,
      database.coverage,
      database.syncLease,
    ],
    async () => {
      await assertTransactionLeadership(database, input.fence)
      const lane =
        (await database.syncLanes.get(input.localScopeKey)) ??
        newLane(input.localScopeKey, input.now)
      if (lane.remoteScopeKey !== null && lane.remoteScopeKey !== page.scopeKey) {
        throw new Error('Activity history scope changed during continuation')
      }
      if (lane.historyCursor !== input.expectedCursor) {
        throw new Error('Activity history cursor is stale')
      }
      if (
        lane.historyThroughSeq !== null &&
        compareDecimalSequence(lane.historyThroughSeq, page.throughSeq) !== 0
      ) {
        throw new Error('Activity history high-water mark changed during continuation')
      }
      if (
        lane.historyRetentionFingerprint !== null &&
        lane.historyRetentionFingerprint !== page.retentionFingerprint
      ) {
        throw new Error('Activity history retention fingerprint changed')
      }
      const replacingGap = lane.checkpointAfterHistory
      if (
        !replacingGap &&
        input.historyBudgetToken !== null &&
        (lane.historyBudgetToken !== input.historyBudgetToken || lane.historyBudgetExhausted)
      ) {
        throw new Error('Activity history budget is stale or exhausted')
      }

      const localRevision = await incrementLocalRevision(database)
      await materializeActivities(database, page.items, input.sanitizer, localRevision)

      lane.remoteScopeKey = page.scopeKey
      lane.historyThroughSeq = page.nextCursor ? page.throughSeq : null
      lane.historyCursor = page.nextCursor
      lane.historyRetentionFingerprint = page.nextCursor ? page.retentionFingerprint : null
      lane.lastUsedAt = input.now
      if (!replacingGap && input.historyBudgetToken !== null) {
        lane.historyBudgetPageCount += 1
        lane.historyBudgetItemCount += page.items.length
        lane.historyBudgetExhausted = activityHistoryBudgetIsExhausted(lane)
      }
      const completesCheckpoint = page.nextCursor === null && lane.checkpointAfterHistory
      if (lane.stableThroughSeq === null && !lane.checkpointAfterHistory) {
        lane.stableThroughSeq = page.throughSeq
      }
      if (page.nextCursor === null && lane.checkpointAfterHistory) {
        lane.stableThroughSeq = page.throughSeq
        lane.checkpointAfterHistory = false
      }
      await Promise.all([
        database.syncLanes.put(lane),
        database.coverage.put({
          scopeKey: input.localScopeKey,
          bootstrap: 'initialized',
          remoteWindow: page.remoteWindowEnd ? 'exhausted' : 'may-have-more',
          integrity: completesCheckpoint
            ? 'continuous'
            : ((await database.coverage.get(input.localScopeKey))?.integrity ?? 'continuous'),
        }),
      ])
      return localRevision
    },
  )
}

export async function commitDeltaPage(input: {
  database: LocalFeedDatabase
  ownerGithubId: string
  localScopeKey: string
  expectedCursor: string | null
  page: ActivityDeltaPage
  sanitizer: ActivitySanitizerPort
  now: number
  fence: LeadershipFence
}) {
  const { database, page } = input
  assertViewer(page.viewerGithubId, input.ownerGithubId)
  if (page.gap) throw new Error('A gap page must be handled before committing its items')

  return database.transaction(
    'rw',
    [
      database.meta,
      database.actors,
      database.activities,
      database.activityBodies,
      database.syncLanes,
      database.syncLease,
    ],
    async () => {
      await assertTransactionLeadership(database, input.fence)
      const lane = await database.syncLanes.get(input.localScopeKey)
      if (!lane?.stableThroughSeq) throw new Error('Activity delta requires a stable checkpoint')
      if (lane.remoteScopeKey !== null && lane.remoteScopeKey !== page.scopeKey) {
        throw new Error('Activity delta scope changed during continuation')
      }
      if (lane.deltaCursor !== input.expectedCursor) {
        throw new Error('Activity delta cursor is stale')
      }
      if (
        lane.deltaThroughSeq !== null &&
        compareDecimalSequence(lane.deltaThroughSeq, page.throughSeq) !== 0
      ) {
        throw new Error('Activity delta high-water mark changed during continuation')
      }
      if (
        lane.deltaRetentionFingerprint !== null &&
        lane.deltaRetentionFingerprint !== page.retentionFingerprint
      ) {
        throw new Error('Activity delta retention fingerprint changed')
      }
      if (compareDecimalSequence(page.throughSeq, lane.stableThroughSeq) < 0) {
        throw new Error('Activity delta moved the checkpoint backwards')
      }

      const localRevision = await incrementLocalRevision(database)
      await materializeActivities(database, page.items, input.sanitizer, localRevision)
      lane.remoteScopeKey = page.scopeKey
      lane.deltaThroughSeq = page.nextCursor ? page.throughSeq : null
      lane.deltaCursor = page.nextCursor
      lane.deltaRetentionFingerprint = page.nextCursor ? page.retentionFingerprint : null
      lane.lastUsedAt = input.now
      if (page.nextCursor === null) lane.stableThroughSeq = page.throughSeq
      await database.syncLanes.put(lane)
      return localRevision
    },
  )
}

export async function markActivityGap(input: {
  database: LocalFeedDatabase
  localScopeKey: string
  now: number
  fence: LeadershipFence
}) {
  return input.database.transaction(
    'rw',
    input.database.meta,
    input.database.syncLanes,
    input.database.coverage,
    input.database.syncLease,
    async () => {
      await assertTransactionLeadership(input.database, input.fence)
      const lane = await input.database.syncLanes.get(input.localScopeKey)
      if (!lane) throw new Error('Cannot mark a gap for an unknown Activity lane')
      lane.deltaThroughSeq = null
      lane.deltaCursor = null
      lane.deltaRetentionFingerprint = null
      lane.historyThroughSeq = null
      lane.historyCursor = null
      lane.historyRetentionFingerprint = null
      lane.checkpointAfterHistory = true
      lane.historyBudgetToken = null
      lane.historyBudgetExhausted = false
      lane.historyBudgetPageCount = 0
      lane.historyBudgetItemCount = 0
      lane.lastUsedAt = input.now
      await Promise.all([
        input.database.syncLanes.put(lane),
        input.database.coverage.put({
          scopeKey: input.localScopeKey,
          bootstrap: 'initialized',
          remoteWindow: 'may-have-more',
          integrity: 'gap-detected',
        }),
      ])
      return incrementLocalRevision(input.database)
    },
  )
}

export async function prepareActivityHistoryBudget(input: {
  database: LocalFeedDatabase
  localScopeKey: string
  token: string
  now: number
  fence: LeadershipFence
}) {
  return input.database.transaction(
    'rw',
    input.database.syncLanes,
    input.database.syncLease,
    async () => {
      await assertTransactionLeadership(input.database, input.fence)
      const lane =
        (await input.database.syncLanes.get(input.localScopeKey)) ??
        newLane(input.localScopeKey, input.now)
      if (lane.checkpointAfterHistory) return true
      if (lane.historyBudgetToken !== input.token) {
        lane.historyBudgetToken = input.token
        lane.historyBudgetExhausted = false
        lane.historyBudgetPageCount = 0
        lane.historyBudgetItemCount = 0
      } else if (activityHistoryBudgetIsExhausted(lane)) {
        lane.historyBudgetExhausted = true
      }
      lane.lastUsedAt = input.now
      await input.database.syncLanes.put(lane)
      return !lane.historyBudgetExhausted
    },
  )
}

export async function exhaustActivityHistoryBudget(input: {
  database: LocalFeedDatabase
  localScopeKey: string
  token: string
  now: number
  fence: LeadershipFence
}) {
  await input.database.transaction(
    'rw',
    input.database.syncLanes,
    input.database.syncLease,
    async () => {
      await assertTransactionLeadership(input.database, input.fence)
      const lane = await input.database.syncLanes.get(input.localScopeKey)
      if (!lane || lane.checkpointAfterHistory) return
      if (lane.historyBudgetToken !== input.token) return
      lane.historyBudgetExhausted = true
      lane.lastUsedAt = input.now
      await input.database.syncLanes.put(lane)
    },
  )
}

export async function commitActivityById(input: {
  database: LocalFeedDatabase
  ownerGithubId: string
  viewerGithubId: string
  activity: RemoteAtomActivity
  sanitizer: ActivitySanitizerPort
  fence: LeadershipFence
}) {
  assertViewer(input.viewerGithubId, input.ownerGithubId)
  return input.database.transaction(
    'rw',
    [
      input.database.meta,
      input.database.actors,
      input.database.activities,
      input.database.activityBodies,
      input.database.syncState,
      input.database.syncLease,
    ],
    async () => {
      await assertTransactionLeadership(input.database, input.fence)
      const localRevision = await incrementLocalRevision(input.database)
      await materializeActivities(input.database, [input.activity], input.sanitizer, localRevision)
      await input.database.syncState.delete(`activity:${input.activity.id}`)
      return localRevision
    },
  )
}

export async function stageFollowingPage(input: {
  database: LocalFeedDatabase
  ownerGithubId: string
  page: FollowingPage
  expectedCursor: string | null
  now: number
  fence: LeadershipFence
}) {
  assertViewer(input.page.viewerGithubId, input.ownerGithubId)
  const pageMembers: FollowingMemberRow[] = input.page.items.map(item => ({
    snapshotRevision: input.page.revision,
    actorKey: item.actorKey,
    actorId: item.githubId,
    login: item.login,
    normalizedLogin: item.login.toLocaleLowerCase('en-US'),
    avatarUrl: item.avatarUrl ?? null,
    followedAt: input.now,
    legacyActorKeys: item.legacyActorKeys,
  }))
  const pageDigest = await digestFollowingMembershipPage(pageMembers)
  return input.database.transaction(
    'rw',
    [
      input.database.meta,
      input.database.followingMembers,
      input.database.followingMemberships,
      input.database.followingAdditions,
      input.database.followingState,
      input.database.syncLease,
    ],
    async () => {
      await assertTransactionLeadership(input.database, input.fence)
      const state = await input.database.followingState.get('active')
      if (!state) throw new Error('Missing local Following state')
      if (state.stagingRevision !== null && state.stagingRevision !== input.page.revision) {
        throw new Error('Following staging revision changed')
      }
      if (state.stagingCursor !== input.expectedCursor) {
        throw new Error('Following staging cursor is stale')
      }
      if (state.stagingComplete) {
        throw new Error('Following staging snapshot is already complete')
      }
      const startingSnapshot = state.stagingRevision === null
      if (startingSnapshot) {
        await Promise.all([
          input.database.followingMembers
            .where('snapshotRevision')
            .equals(input.page.revision)
            .delete(),
          input.database.followingMemberships
            .where('snapshotRevision')
            .equals(input.page.revision)
            .delete(),
          input.database.followingAdditions
            .where('snapshotRevision')
            .equals(input.page.revision)
            .delete(),
        ])
      }

      const membershipByActorKey = new Map<string, FollowingMembershipRow>()
      for (const member of pageMembers) {
        for (const actorKey of [member.actorKey, ...member.legacyActorKeys]) {
          membershipByActorKey.set(actorKey, {
            snapshotRevision: member.snapshotRevision,
            actorKey,
            memberActorKey: member.actorKey,
          })
        }
      }
      const memberships = [...membershipByActorKey.values()]
      const oldMemberships = state.activeRevision
        ? await input.database.followingMemberships.bulkGet(
            memberships.map(membership => [state.activeRevision!, membership.actorKey]),
          )
        : []
      const additions: FollowingAdditionRow[] = state.activeRevision
        ? memberships.flatMap((membership, index) =>
            oldMemberships[index]
              ? []
              : [
                  {
                    snapshotRevision: input.page.revision,
                    actorKey: membership.actorKey,
                  },
                ],
          )
        : []
      const digest = startingSnapshot
        ? pageDigest
        : mergeFollowingMembershipDigests(
            {
              xor: state.stagingMembershipDigest ?? '',
              count: state.stagingMembershipCount ?? 0,
            },
            pageDigest,
          )
      await Promise.all([
        pageMembers.length > 0 ? input.database.followingMembers.bulkPut(pageMembers) : undefined,
        memberships.length > 0
          ? input.database.followingMemberships.bulkPut(memberships)
          : undefined,
        additions.length > 0 ? input.database.followingAdditions.bulkPut(additions) : undefined,
      ])
      state.stagingRevision = input.page.revision
      state.stagingCursor = input.page.nextCursor
      state.stagingComplete = input.page.nextCursor === null
      state.stagingFinalizeCursorActorKey = null
      state.stagingMembershipDigest = digest.xor
      state.stagingMembershipCount = digest.count
      await input.database.followingState.put(state)
      return null
    },
  )
}

export async function finalizeFollowingSnapshot(input: {
  database: LocalFeedDatabase
  targetThroughSeq: string
  fence: LeadershipFence
  batchSize?: number
}) {
  return input.database.transaction(
    'rw',
    [
      input.database.meta,
      input.database.actors,
      input.database.followingMembers,
      input.database.followingAdditions,
      input.database.followingState,
      input.database.syncLease,
    ],
    async () => {
      await assertTransactionLeadership(input.database, input.fence)
      const state = await input.database.followingState.get('active')
      if (!state?.stagingRevision || !state.stagingComplete) {
        throw new Error('Following snapshot is not ready to finalize')
      }
      const revision = state.stagingRevision
      const members = await input.database.followingMembers
        .where('[snapshotRevision+actorKey]')
        .between(
          [revision, state.stagingFinalizeCursorActorKey ?? Dexie.minKey],
          [revision, Dexie.maxKey],
          state.stagingFinalizeCursorActorKey === null ||
            state.stagingFinalizeCursorActorKey === undefined,
          true,
        )
        .limit(Math.max(1, input.batchSize ?? 250))
        .toArray()
      if (members.length > 0) {
        const actorKeys = members.flatMap(member => [member.actorKey, ...member.legacyActorKeys])
        const existingActors = await input.database.actors.bulkGet(actorKeys)
        await input.database.actors.bulkPut(planFollowingActorRows(existingActors, members))
        state.stagingFinalizeCursorActorKey = members.at(-1)!.actorKey
        await input.database.followingState.put(state)
        return { done: false as const, localRevision: null }
      }

      const membershipSignature = followingMembershipSignatureFromDigest({
        xor: state.stagingMembershipDigest ?? '',
        count: state.stagingMembershipCount ?? 0,
      })
      const addedActorCount = await input.database.followingAdditions
        .where('snapshotRevision')
        .equals(revision)
        .count()
      Object.assign(
        state,
        promoteFollowingSnapshot({
          state,
          newRevision: revision,
          targetThroughSeq: input.targetThroughSeq,
          addedActorCount,
          membershipSignature,
        }),
      )
      await input.database.followingState.put(state)
      return { done: true as const, localRevision: await incrementLocalRevision(input.database) }
    },
  )
}
