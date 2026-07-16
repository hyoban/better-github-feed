import assert from 'node:assert/strict'

import { emptyFilterGroup } from '@better-github-feed/shared'
import { ORPCError } from '@orpc/client'
import { describe, it } from 'vite-plus/test'

import { createMemoryAccountGenerationPort } from './account-generation'
import type { AccountGenerationPort } from './account-generation'
import { expandAuthorizedActorSelection } from './actor-scope'
import {
  activityProjectionAccountIsCurrent,
  activityProjectionSignature,
  effectiveActivityClearFence,
  followingSummarySortKey,
  isActivityCleared,
  upgradeActivityBodySanitization,
} from './activity-projection'
import { CloudReplicaError } from './cloud-replica'
import type { RemoteAtomActivity } from './cloud-replica'
import type { OutboxRow } from './database'
import {
  databaseAccountBindingIsCompatible,
  normalizeInsertedRevision,
  runBoundedDatabaseDelete,
} from './database'
import {
  completeFollowingTransition,
  deriveFollowingTransitionCoverage,
  followingMembershipSignature,
  planFollowingTransition,
  promoteFollowingSnapshot,
} from './following-transition'
import {
  activityHistoryBudgetToken,
  canReuseTerminalActivityResolution,
  canPullActivityDelta,
  canonicalizeProjection,
  canonicalProjectionKey,
  chunkActorKeys,
  computeRateLimitRetryAt,
  computeUnavailableRetryAt,
  didServerEpochChange,
  followingManifestRequiresReauthentication,
  remoteDemandLeaseExpiresAt,
  remoteDemandLeaseIsCurrent,
  settleWithin,
  shouldPullActivityHistory,
  shouldRunForegroundSync,
} from './incremental-sync'
import { projectionDependsOn } from './local-feed'
import { createOrpcCloudReplicaPort } from './orpc-cloud-replica'
import type { LocalFeedV1OrpcClient } from './orpc-cloud-replica'
import {
  activityFactQueryPlan,
  activityScopeKey,
  aggregateFollowingActivityStats,
  aggregateFollowingAggregates,
  readNewestActivityFacts,
  selectActivityAggregateLanes,
} from './projections'
import {
  activityHistoryBudgetIsExhausted,
  activityBudgetTransactionTables,
  compareDecimalSequence,
  planActivityActorRows,
  planFollowingActorRows,
} from './replica-writes'
import { leadershipRetryDelay, transactionFenceValidity } from './tab-coordinator'
import type { LeadershipFence } from './tab-coordinator'
import type { Projection } from './types'
import { isStorageQuotaError } from './storage-errors'
import { mergeThreeWay, retargetFilterMutationChain } from './user-state'

async function exerciseExclusiveActivation(generations: AccountGenerationPort) {
  const firstA = (await generations.activateExclusive('1')).account
  const sameA = await generations.activateExclusive('1')
  const firstB = (await generations.activateExclusive('2')).account
  const secondA = (await generations.activateExclusive('1')).account

  assert.equal(firstA.ownerGithubId, '1')
  assert.equal(firstA.generation, 0)
  assert.equal(firstA.state, 'active')
  assert.ok(firstA.nonce)
  assert.equal(sameA.account.generation, firstA.generation)
  assert.deepEqual(sameA.changedAccounts, [])
  assert.equal(firstB.ownerGithubId, '2')
  assert.equal(firstB.generation, 2)
  assert.equal(firstB.state, 'active')
  assert.equal((await generations.read('2'))?.generation, 3)
  assert.equal((await generations.read('2'))?.state, 'locked')
  assert.equal(secondA.ownerGithubId, '1')
  assert.equal(secondA.generation, 4)
  assert.equal(secondA.state, 'active')
  assert.deepEqual(await generations.readActive(), secondA)
  assert.equal(await generations.isCurrent(firstA), false)
}

function activity(
  actorKey: string,
  actorLogin: string,
  actorGithubId: string | null,
): RemoteAtomActivity {
  return {
    id: `${actorKey}:${actorLogin}`,
    source: 'github-atom-v1',
    actorKey,
    actorGithubId,
    actorLogin,
    title: 'Activity',
    link: null,
    repo: null,
    type: 'PushEvent',
    publishedAt: '2026-07-16T00:00:00.000Z',
    publishedAtMs: 1_752_624_000_000,
    summary: null,
    content: null,
  }
}

describe('LocalFeed pure invariants', () => {
  it('includes every account-fence store in Activity budget transactions', () => {
    const database = {
      meta: { name: 'meta' },
      syncLanes: { name: 'syncLanes' },
      syncLease: { name: 'syncLease' },
    } as unknown as Parameters<typeof activityBudgetTransactionTables>[0]

    assert.deepEqual(
      activityBudgetTransactionTables(database).map(store => store.name),
      ['meta', 'syncLanes', 'syncLease'],
    )
  })

  it('compares decimal sequences without losing 64-bit precision', () => {
    assert.equal(compareDecimalSequence('9223372036854775807', '9223372036854775806'), 1)
    assert.equal(compareDecimalSequence('00042', '42'), 0)
    assert.throws(() => compareDecimalSequence('1e3', '1000'), RangeError)
  })

  it('backfills a safe projection revision for pre-v2 Activity rows', () => {
    assert.equal(normalizeInsertedRevision(undefined), 0)
    assert.equal(normalizeInsertedRevision(-1), 0)
    assert.equal(normalizeInsertedRevision(42), 42)
  })

  it('keeps a single active account across A -> B -> A', async () => {
    await exerciseExclusiveActivation(createMemoryAccountGenerationPort())
  })

  it('never reports a timed-out or failed database deletion as deleted', async () => {
    assert.equal(await runBoundedDatabaseDelete(() => new Promise(() => undefined), 1), 'pending')
    assert.equal(
      await runBoundedDatabaseDelete(() => Promise.reject(new Error('blocked')), 10),
      'pending',
    )
    assert.equal(await runBoundedDatabaseDelete(() => Promise.resolve(), 10), 'deleted')
  })

  it('bounds shutdown while an in-flight cloud operation remains unresolved', async () => {
    assert.equal(await settleWithin(Promise.resolve(), 10), true)
    assert.equal(await settleWithin(new Promise(() => undefined), 1), false)
  })

  it('recognizes both native and Dexie-style quota failures by error name', () => {
    const dexieQuotaError = new Error('Quota exceeded')
    dexieQuotaError.name = 'QuotaExceededError'
    assert.equal(isStorageQuotaError(dexieQuotaError), true)
    assert.equal(isStorageQuotaError(new Error('Quota exceeded')), false)
  })

  it('persists a resumable Following transition and derives reusable coverage', () => {
    const oldMembers = [{ actorKey: 'alice', legacyActorKeys: ['alice-old'] }]
    const newMembers = [
      { actorKey: 'alice', legacyActorKeys: ['alice-new'] },
      { actorKey: 'bob', legacyActorKeys: [] },
    ]
    const plan = planFollowingTransition({
      oldRevision: 'old',
      newRevision: 'new',
      targetThroughSeq: '100',
      oldMembers,
      newMembers,
    })!
    assert.equal(plan.addedActorCount, 2)

    const promoted = promoteFollowingSnapshot({
      state: {
        activeRevision: 'old',
        stagingRevision: 'new',
        stagingCursor: 'cursor',
      },
      newRevision: 'new',
      targetThroughSeq: '100',
      addedActorCount: plan.addedActorCount,
    })
    const afterCrash = structuredClone(promoted)
    assert.deepEqual(afterCrash.pendingTransition, plan)
    assert.equal(completeFollowingTransition(afterCrash, plan).pendingTransition, null)

    assert.equal(
      deriveFollowingTransitionCoverage({
        oldRemoteWindow: 'exhausted',
        existingRemoteWindow: null,
        completedReplacementHistory: false,
        completedAddedActorHistory: true,
      }).remoteWindow,
      'exhausted',
    )
    assert.equal(
      deriveFollowingTransitionCoverage({
        oldRemoteWindow: 'may-have-more',
        existingRemoteWindow: null,
        completedReplacementHistory: false,
        completedAddedActorHistory: true,
      }).remoteWindow,
      'may-have-more',
    )
  })

  it('hashes Following membership independently of page order and sorts latest ties by login', async () => {
    const left = await followingMembershipSignature([
      { actorKey: 'github:2', legacyActorKeys: ['login:bob'] },
      { actorKey: 'github:1', legacyActorKeys: ['login:alice'] },
    ])
    const right = await followingMembershipSignature([
      { actorKey: 'github:1', legacyActorKeys: ['login:alice'] },
      { actorKey: 'github:2', legacyActorKeys: ['login:bob'] },
    ])
    assert.equal(left, right)
    assert.notEqual(
      left,
      await followingMembershipSignature([
        { actorKey: 'github:1', legacyActorKeys: ['login:alice'] },
      ]),
    )
    assert.ok(followingSummarySortKey(200, 'zoe') < followingSummarySortKey(100, 'alice'))
    assert.ok(followingSummarySortKey(100, 'alice') < followingSummarySortKey(100, 'bob'))
  })

  it('does not let replacement history restart delta after a gap', () => {
    assert.equal(
      canPullActivityDelta({ stableThroughSeq: '100', checkpointAfterHistory: true }),
      false,
    )
    assert.equal(
      canPullActivityDelta({ stableThroughSeq: '100', checkpointAfterHistory: false }),
      true,
    )
    assert.equal(
      shouldPullActivityHistory(
        { checkpointAfterHistory: true, stableThroughSeq: '100' },
        true,
        'exhausted',
      ),
      true,
    )
    assert.equal(
      shouldPullActivityHistory(
        { checkpointAfterHistory: false, stableThroughSeq: '100' },
        true,
        'may-have-more',
      ),
      false,
    )
    assert.equal(
      shouldPullActivityHistory(
        { checkpointAfterHistory: false, stableThroughSeq: '100' },
        false,
        'exhausted',
      ),
      false,
    )
    assert.equal(
      shouldPullActivityHistory(
        { checkpointAfterHistory: false, stableThroughSeq: '100' },
        false,
        'may-have-more',
      ),
      true,
    )
    assert.equal(shouldPullActivityHistory(null, true, 'exhausted'), true)
    assert.equal(
      shouldPullActivityHistory(
        { checkpointAfterHistory: false, stableThroughSeq: null },
        true,
        'exhausted',
      ),
      true,
    )
    assert.equal(didServerEpochChange('epoch-a', 'epoch-b'), true)
    assert.equal(didServerEpochChange(undefined, 'epoch-a'), false)
    assert.equal(shouldRunForegroundSync(false), false)
    assert.equal(remoteDemandLeaseIsCurrent(remoteDemandLeaseExpiresAt(1_000), 1_000), true)
    assert.equal(remoteDemandLeaseIsCurrent(remoteDemandLeaseExpiresAt(1_000), 901_000), false)
    assert.equal(remoteDemandLeaseIsCurrent(undefined, 1_000), false)
    assert.equal(
      leadershipRetryDelay(2_000, 1_000, () => 0),
      1_025,
    )
    assert.equal(
      leadershipRetryDelay(900, 1_000, () => 1),
      250,
    )
    const baseBudget = activityHistoryBudgetToken(
      [
        { kind: 'visible-feed', view: { actors: 'following', types: 'all' }, first: 20 },
        { kind: 'visible-feed', view: { actors: 'following', types: 'all' }, first: 20 },
      ],
      'filters-a',
    )
    assert.equal(
      baseBudget,
      activityHistoryBudgetToken(
        [{ kind: 'visible-feed', view: { actors: 'following', types: 'all' }, first: 20 }],
        'filters-a',
      ),
    )
    assert.notEqual(
      baseBudget,
      activityHistoryBudgetToken(
        [{ kind: 'visible-feed', view: { actors: 'following', types: 'all' }, first: 40 }],
        'filters-a',
      ),
    )
    assert.notEqual(
      baseBudget,
      activityHistoryBudgetToken(
        [{ kind: 'visible-feed', view: { actors: 'following', types: 'all' }, first: 20 }],
        'filters-b',
      ),
    )
    assert.equal(
      activityHistoryBudgetIsExhausted({
        historyBudgetExhausted: false,
        historyBudgetPageCount: 4,
        historyBudgetItemCount: 499,
      }),
      false,
    )
    assert.equal(
      activityHistoryBudgetIsExhausted({
        historyBudgetExhausted: false,
        historyBudgetPageCount: 5,
        historyBudgetItemCount: 1,
      }),
      true,
    )
    assert.equal(
      activityHistoryBudgetIsExhausted({
        historyBudgetExhausted: false,
        historyBudgetPageCount: 1,
        historyBudgetItemCount: 500,
      }),
      true,
    )
  })

  it('canonicalizes equivalent demand keys and pins oversized actor scopes to Following', () => {
    const left = {
      kind: 'visible-feed',
      view: { actors: ['b', 'a'], types: ['WatchEvent', 'PushEvent'] },
      first: 20,
    } as Projection
    const right = {
      kind: 'visible-feed',
      view: { actors: ['a', 'b', 'a'], types: ['PushEvent', 'WatchEvent', 'PushEvent'] },
      first: 20,
    } as Projection
    assert.equal(canonicalProjectionKey(left), canonicalProjectionKey(right))
    const actorKeys = Array.from({ length: 251 }, (_, index) => `actor-${index}`)
    assert.equal(
      activityScopeKey(actorKeys as [string, ...string[]], 'following-revision'),
      'following:following-revision',
    )
    assert.equal(
      activityScopeKey(['github:1'], 'following-revision-a'),
      activityScopeKey(['github:1'], 'following-revision-b'),
    )
    assert.notEqual(
      activityScopeKey('following', 'following-revision-a'),
      activityScopeKey('following', 'following-revision-b'),
    )
    assert.equal(activityFactQueryPlan(actorKeys as [string, ...string[]], 'all'), 'actor')
    assert.equal(activityFactQueryPlan('following', ['PushEvent']), 'following-type')
    assert.equal(
      activityFactQueryPlan(actorKeys.slice(0, 250) as [string, ...string[]], ['PushEvent']),
      'actor-type-aggregated',
    )
    assert.equal(
      activityFactQueryPlan(
        actorKeys.slice(0, 250) as [string, ...string[]],
        Array.from({ length: 64 }, (_, index) => `type-${index}`) as [string, ...string[]],
      ),
      'actor-type-aggregated',
    )
    const bounded = canonicalizeProjection({
      kind: 'visible-feed',
      view: {
        actors: Array.from({ length: 300 }, (_, index) => `actor-${index}`) as [
          string,
          ...string[],
        ],
        types: Array.from({ length: 70 }, (_, index) => `type-${index}`) as [string, ...string[]],
      },
      first: 20,
    })
    assert.equal(bounded.view.actors.length, 250)
    assert.equal(bounded.view.types.length, 64)
    const invalidOnly = canonicalizeProjection({
      kind: 'visible-feed',
      view: { actors: [''], types: ['x'.repeat(257)] },
      first: 20,
    })
    assert.deepEqual(invalidOnly.view.actors, ['better-github-feed:invalid-selection'])
    assert.deepEqual(invalidOnly.view.types, ['better-github-feed:invalid-selection'])
    assert.equal(canonicalizeProjection({ kind: 'activity', id: 'x'.repeat(1001) }).id, '')
    assert.deepEqual(
      chunkActorKeys(actorKeys, 250).map(chunk => chunk.length),
      [250, 1],
    )
    assert.equal(
      computeRateLimitRetryAt(10_000, 5_000, () => 0.5),
      12_500,
    )
    assert.equal(
      computeUnavailableRetryAt(0, 5_000, () => 0.5),
      6_100,
    )
    assert.equal(
      computeUnavailableRetryAt(2, 5_000, () => 0),
      9_000,
    )
  })

  it('retries terminal Activity detail results after the relevant manifest changes', () => {
    const manifest = {
      protocol: 1 as const,
      serverEpoch: 'epoch',
      viewerGithubId: '1',
      serverTime: 1,
      timeAnchor: 'anchor',
      activity: { headSeq: '10', retentionGeneration: '0' },
      following: { revision: 'following-a', completedAt: 1, reauthRequiredAt: null },
      userState: { revision: '0', epoch: 'user-state' },
    }
    assert.equal(followingManifestRequiresReauthentication(manifest), false)
    assert.equal(
      followingManifestRequiresReauthentication({
        ...manifest,
        following: { ...manifest.following, reauthRequiredAt: 123 },
      }),
      true,
    )
    const cached = {
      activityResult: 'cloud-miss' as const,
      activityResultAtHeadSeq: '10',
      activityResultAtFollowingRevision: 'following-a',
    }
    assert.equal(canReuseTerminalActivityResolution(cached, manifest), true)
    assert.equal(
      canReuseTerminalActivityResolution(cached, {
        ...manifest,
        activity: { ...manifest.activity, headSeq: '11' },
      }),
      false,
    )
    assert.equal(
      canReuseTerminalActivityResolution(cached, {
        ...manifest,
        following: { ...manifest.following, revision: 'following-b' },
      }),
      false,
    )
  })

  it('merges indexed actor lanes by global recency without per-lane demand expansion', async () => {
    const makeFact = (activityId: string, actorKey: string, publishedAt: number) => ({
      key: `1:${activityId}`,
      generation: 1,
      activityId,
      actorKey,
      type: 'PushEvent',
      publishedAt,
      visible: 1 as const,
    })
    const lane =
      (facts: ReturnType<typeof makeFact>[]) =>
      async (before: { activityId: string } | null, limit: number) => {
        const offset = before
          ? facts.findIndex(fact => fact.activityId === before.activityId) + 1
          : 0
        return facts.slice(offset, offset + limit)
      }
    const result = await readNewestActivityFacts(
      [
        lane([makeFact('a-30', 'a', 30), makeFact('a-10', 'a', 10)]),
        lane([makeFact('b-40', 'b', 40), makeFact('b-20', 'b', 20)]),
      ],
      4,
      2,
    )
    assert.deepEqual(
      result.map(fact => fact.activityId),
      ['b-40', 'a-30', 'b-20', 'a-10'],
    )
  })

  it('selects aggregate-guided exact lanes through the candidate cutoff including ties', () => {
    const aggregates = [
      {
        key: '1:a:push',
        generation: 1,
        actorKey: 'a',
        type: 'PushEvent',
        count: 10,
        latest: 50,
      },
      {
        key: '1:b:watch',
        generation: 1,
        actorKey: 'b',
        type: 'WatchEvent',
        count: 1,
        latest: 40,
      },
      {
        key: '1:c:issue',
        generation: 1,
        actorKey: 'c',
        type: 'IssuesEvent',
        count: 2,
        latest: 40,
      },
      {
        key: '1:d:fork',
        generation: 1,
        actorKey: 'd',
        type: 'ForkEvent',
        count: 3,
        latest: 30,
      },
      {
        key: '1:e:zero',
        generation: 1,
        actorKey: 'e',
        type: 'PullRequestEvent',
        count: 0,
        latest: 100,
      },
    ]

    assert.deepEqual(
      selectActivityAggregateLanes(aggregates, 2).map(aggregate => aggregate.key),
      ['1:a:push', '1:b:watch', '1:c:issue'],
    )
    assert.deepEqual(selectActivityAggregateLanes(aggregates, 0), [])
  })

  it('does not invalidate data projections for status-only revisions', () => {
    assert.equal(projectionDependsOn('sync-status', 'status'), true)
    assert.equal(projectionDependsOn('visible-feed', 'status'), false)
    assert.equal(projectionDependsOn('statistics', 'status'), false)
    assert.equal(projectionDependsOn('visible-feed', 'data'), true)
  })

  it('fences projection maintenance with the account nonce as well as generation', () => {
    const expected = { ownerGithubId: '1', generation: 4, nonce: 'current' }
    assert.equal(
      activityProjectionAccountIsCurrent(expected, {
        ownerGithubId: '1',
        generation: 4,
        nonce: 'current',
      }),
      true,
    )
    assert.equal(
      activityProjectionAccountIsCurrent(expected, {
        ownerGithubId: '1',
        generation: 4,
        nonce: 'stale',
      }),
      false,
    )
    assert.equal(
      databaseAccountBindingIsCompatible({
        storedGeneration: 4,
        storedNonce: 'stale',
        nextGeneration: 4,
        nextNonce: 'current',
      }),
      false,
    )
    assert.equal(
      databaseAccountBindingIsCompatible({
        storedGeneration: 3,
        storedNonce: 'stale',
        nextGeneration: 4,
        nextNonce: 'current',
      }),
      true,
    )
    assert.equal(
      databaseAccountBindingIsCompatible({
        storedGeneration: Number.NaN,
        storedNonce: 'stale',
        nextGeneration: 4,
        nextNonce: 'current',
      }),
      false,
    )
  })

  it('keeps current Following presentation while retaining event-time actor login', () => {
    const existing = {
      actorKey: 'github:1',
      githubId: '1',
      login: 'current-login',
      normalizedLogin: 'current-login',
      avatarUrl: 'avatar',
    }
    assert.deepEqual(
      planActivityActorRows(
        [existing],
        [activity('github:1', 'older-login', '1'), activity('github:1', 'oldest-login', '1')],
      ),
      [],
    )
    assert.equal(
      planActivityActorRows(
        [],
        [activity('github:2', 'newer-login', '2'), activity('github:2', 'older-login', '2')],
      )[0]?.login,
      'newer-login',
    )
  })

  it('attributes legacy actor activity to the canonical Following member', () => {
    const stats = aggregateFollowingActivityStats(
      [{ actorKey: 'github:1', legacyActorKeys: ['login:old'] }],
      [
        { actorKey: 'login:old', publishedAt: 10 },
        { actorKey: 'github:1', publishedAt: 20 },
      ],
    )
    assert.deepEqual(stats.get('github:1'), { count: 2, latest: 20 })
    assert.deepEqual(
      expandAuthorizedActorSelection(
        [{ actorKey: 'github:1', legacyActorKeys: ['login:old', 'login:older'] }],
        ['github:1', 'not-followed'],
      ),
      {
        actorKeys: ['github:1', 'login:old', 'login:older'],
        rejectedActorKeys: ['not-followed'],
      },
    )
  })

  it('ignores legacy clear watermarks after manual feed clearing is retired', () => {
    const fence = effectiveActivityClearFence({
      serverClearedAt: 100,
      optimisticClearedAt: 200,
      provisionalThroughRevision: 7,
    })
    assert.deepEqual(fence, { publishedAt: null, throughRevision: null })
    assert.equal(isActivityCleared({ publishedAt: 150, insertedRevision: 8 }, fence), false)
    assert.equal(isActivityCleared({ publishedAt: 250, insertedRevision: 7 }, fence), false)
    assert.equal(isActivityCleared({ publishedAt: 250, insertedRevision: 8 }, fence), false)
  })

  it('keeps projection generations stable across equivalent membership snapshots', () => {
    const feedState = {
      serverClearedAt: null,
      optimisticClearedAt: null,
      provisionalThroughRevision: null,
    }
    const left = activityProjectionSignature({
      filters: [
        { id: 'b', rule: null, deletedAt: null },
        { id: 'a', rule: null, deletedAt: null },
      ],
      feedState,
      sanitizerVersion: 'v1',
      followingMembershipSignature: 'membership-a',
    })
    const right = activityProjectionSignature({
      filters: [
        { id: 'a', rule: null, deletedAt: null },
        { id: 'b', rule: null, deletedAt: null },
      ],
      feedState,
      sanitizerVersion: 'v1',
      followingMembershipSignature: 'membership-a',
    })
    assert.equal(left, right)
    assert.notEqual(
      left,
      activityProjectionSignature({
        filters: [],
        feedState,
        sanitizerVersion: 'v1',
        followingMembershipSignature: 'membership-b',
      }),
    )
    assert.notEqual(
      left,
      activityProjectionSignature({
        filters: [],
        feedState,
        sanitizerVersion: 'v2',
      }),
    )
  })

  it('re-sanitizes stored Activity bodies when the sanitizer version changes', () => {
    const migrated = upgradeActivityBodySanitization(
      {
        activityId: 'activity',
        summary: null,
        content: '<p>safe</p><script>unsafe</script>',
        sanitizerVersion: 'v1',
      },
      {
        version: 'v2',
        sanitizeHtml: html => html.replace(/<script>.*<\/script>/, ''),
      },
    )
    assert.deepEqual(migrated, {
      activityId: 'activity',
      summary: null,
      content: '<p>safe</p>',
      sanitizerVersion: 'v2',
    })
  })

  it('promotes Following presentation from the complete snapshot and aggregates aliases', () => {
    const rows = planFollowingActorRows(
      [
        {
          actorKey: 'github:1',
          githubId: '1',
          login: 'old',
          normalizedLogin: 'old',
          avatarUrl: 'old-avatar',
        },
        undefined,
      ],
      [
        {
          actorKey: 'github:1',
          actorId: '1',
          login: 'new',
          avatarUrl: null,
          legacyActorKeys: ['login:old'],
        },
      ],
    )
    assert.deepEqual(rows, [
      {
        actorKey: 'github:1',
        githubId: '1',
        login: 'new',
        normalizedLogin: 'new',
        avatarUrl: 'old-avatar',
      },
      {
        actorKey: 'login:old',
        githubId: '1',
        login: 'new',
        normalizedLogin: 'new',
        avatarUrl: null,
      },
    ])
    assert.deepEqual(
      aggregateFollowingAggregates(
        [{ actorKey: 'github:1', legacyActorKeys: ['login:old'] }],
        [
          { actorKey: 'github:1', count: 2, latest: 20 },
          { actorKey: 'login:old', count: 3, latest: 30 },
        ],
      ).get('github:1'),
      { count: 5, latest: 30 },
    )
  })

  it('uses stable IDs for disjoint Filter merges and preserves causal local edits', () => {
    const base = {
      conditions: [
        { id: 'a', value: 1 },
        { id: 'b', value: 1 },
      ],
    }
    const local = {
      conditions: [
        { id: 'a', value: 2 },
        { id: 'b', value: 1 },
      ],
    }
    const remote = {
      conditions: [
        { id: 'a', value: 1 },
        { id: 'b', value: 2 },
      ],
    }
    assert.deepEqual(mergeThreeWay(base, local, remote), {
      kind: 'merged',
      value: {
        conditions: [
          { id: 'a', value: 2 },
          { id: 'b', value: 2 },
        ],
      },
    })
    assert.deepEqual(mergeThreeWay({ name: 'first' }, { name: 'second' }, { name: 'first' }), {
      kind: 'merged',
      value: { name: 'second' },
    })
    assert.deepEqual(mergeThreeWay({ name: 'base' }, { name: 'local' }, { name: 'remote' }), {
      kind: 'conflict',
    })
  })

  it('retargets the complete causal Filter chain when creating a conflict copy', () => {
    const row = (localSequence: number, operation: OutboxRow['operation']): OutboxRow => ({
      mutationId: `mutation-${localSequence}`,
      attemptId: `old-attempt-${localSequence}`,
      localSequence,
      entityKey: 'filter:original',
      baseVersion: 1,
      baseValue: null,
      operation,
      status: 'pending',
      conflictCopy: false,
      createdAt: localSequence,
    })
    let attempt = 0
    const retargeted = retargetFilterMutationChain({
      rows: [
        row(2, {
          kind: 'filter.put',
          filter: { id: 'original', name: 'updated', rule: emptyFilterGroup },
        }),
        row(3, { kind: 'filter.delete', id: 'original' }),
      ],
      oldId: 'original',
      newId: 'conflict-copy',
      createAttemptId: () => `new-attempt-${++attempt}`,
    })
    assert.deepEqual(
      retargeted.map(item => ({
        entityKey: item.entityKey,
        attemptId: item.attemptId,
        conflictCopy: item.conflictCopy,
        id:
          item.operation.kind === 'filter.put'
            ? item.operation.filter.id
            : item.operation.kind === 'filter.delete'
              ? item.operation.id
              : null,
      })),
      [
        {
          entityKey: 'filter:conflict-copy',
          attemptId: 'new-attempt-1',
          conflictCopy: true,
          id: 'conflict-copy',
        },
        {
          entityKey: 'filter:conflict-copy',
          attemptId: 'new-attempt-2',
          conflictCopy: true,
          id: 'conflict-copy',
        },
      ],
    )
  })

  it('rejects a stale leader or account generation inside a write transaction', () => {
    const fence: LeadershipFence = {
      token: '7',
      isCurrent: async () => true,
      transactionProof: { owner: 'tab-a', now: () => 100 },
      accountProof: { ownerGithubId: '1', generation: 3, nonce: 'current-nonce' },
    }
    assert.deepEqual(
      transactionFenceValidity({
        fence,
        lease: { owner: 'tab-a', fencingToken: '7', expiresAt: 101 },
        ownerGithubId: '1',
        accountGeneration: 3,
        accountNonce: 'current-nonce',
      }),
      { leadership: true, account: true },
    )
    assert.equal(
      transactionFenceValidity({
        fence,
        lease: { owner: 'tab-a', fencingToken: '7', expiresAt: 101 },
        ownerGithubId: '1',
        accountGeneration: 3,
        accountNonce: 'reconstructed-registry-nonce',
      }).account,
      false,
    )
    assert.equal(
      transactionFenceValidity({
        fence,
        lease: { owner: 'tab-b', fencingToken: '8', expiresAt: 101 },
        ownerGithubId: '1',
        accountGeneration: 4,
      }).leadership,
      false,
    )
  })

  it('uses server receipt time for an offline clear without a time anchor', async () => {
    let captured: unknown
    const client = {
      localFeedV1: {
        pushUserMutation: async (input: unknown) => {
          captured = input
          return {
            viewerGithubId: '1',
            kind: 'applied',
            entityKind: 'feed-state',
            replica: { activityClearedAt: 1234, version: 1, changedRevision: '9' },
          }
        },
      },
    } as unknown as LocalFeedV1OrpcClient
    const port = createOrpcCloudReplicaPort(client)
    const result = await port.pushUserMutation({
      mutation: {
        kind: 'feed.clear',
        mutationId: 'mutation',
        attemptId: 'attempt',
        baseVersion: 0,
        candidate: null,
        timeAnchor: null,
      },
    })
    assert.deepEqual(captured, {
      body: {
        kind: 'feed.clear',
        mutationId: 'mutation',
        attemptId: 'attempt',
        baseVersion: 0,
        candidate: 0,
      },
    })
    assert.equal(result.feedState?.clearedAt, 1234)
  })

  it('preserves the cloud rate-limit deadline from oRPC errors', async () => {
    const client = {
      localFeedV1: {
        getManifest: async () => {
          throw new ORPCError('TOO_MANY_REQUESTS', { data: { retryAt: 9_000_000_000_000 } })
        },
      },
    } as unknown as LocalFeedV1OrpcClient
    const port = createOrpcCloudReplicaPort(client)
    await assert.rejects(port.getManifest({}), error => {
      assert.ok(error instanceof CloudReplicaError)
      assert.equal(error.code, 'RATE_LIMITED')
      assert.equal(error.retryAt, 9_000_000_000_000)
      return true
    })
  })

  it('normalizes a legacy manifest without Following authorization state', async () => {
    const client = {
      localFeedV1: {
        getManifest: async () => ({
          kind: 'manifest' as const,
          manifest: {
            protocol: 1 as const,
            serverEpoch: 'legacy-server',
            viewerGithubId: '1',
            serverTime: 1,
            timeAnchor: 'anchor',
            activity: { headSeq: '0', retentionGeneration: '0' },
            following: { revision: 'following-a', completedAt: 1 },
            userState: { revision: '0', epoch: 'user-state' },
          },
          etag: 'legacy-etag',
          bookmark: null,
        }),
      },
    } as unknown as LocalFeedV1OrpcClient
    const result = await createOrpcCloudReplicaPort(client).getManifest({})
    assert.equal(result.kind, 'manifest')
    if (result.kind !== 'manifest') assert.fail('Expected a manifest')
    assert.equal(result.manifest.following.reauthRequiredAt, null)
    assert.equal(followingManifestRequiresReauthentication(result.manifest), false)
  })

  it('maps the stable GitHub authorization reason to reauthentication', async () => {
    const client = {
      localFeedV1: {
        getManifest: async () => {
          throw new ORPCError('PRECONDITION_FAILED', {
            message: 'Reconnect your GitHub account before syncing follows',
            data: { reason: 'REAUTH_REQUIRED' },
          })
        },
      },
    } as unknown as LocalFeedV1OrpcClient
    const port = createOrpcCloudReplicaPort(client)
    await assert.rejects(port.getManifest({}), error => {
      assert.ok(error instanceof CloudReplicaError)
      assert.equal(error.code, 'REAUTH_REQUIRED')
      return true
    })
  })
})
