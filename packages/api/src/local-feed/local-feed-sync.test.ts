import assert from 'node:assert/strict'

import { account, user } from '@better-github-feed/db/schema/auth'
import {
  activityChange,
  activityRetentionState,
  activitySyncState,
  feedItem,
  githubUser,
  localFeedServerState,
  userFeedState,
  userFilter,
  userMutationReceipt,
  userStateChange,
  userStateSyncState,
} from '@better-github-feed/db/schema/github'
import { emptyFilterGroup } from '@better-github-feed/shared'
import type { FilterGroup } from '@better-github-feed/shared'
import { asc, eq, sql } from 'drizzle-orm'
import { afterEach, describe, it } from 'vite-plus/test'

import { createFeedRefresh } from '../feed/feed-refresh.ts'
import { createActivityCleanup } from '../feed/activity-cleanup.ts'
import { createActivityReconciliation } from '../feed/activity-reconciliation.ts'
import { markActivityReconciled } from '../feed/activity-rollout.ts'
import { createFollowingSync } from '../following/following-sync.ts'
import { createTestDatabase } from '../test/database.ts'
import {
  createLocalFeedSync,
  LocalFeedAuthorizationError,
  LocalFeedCursorError,
} from './local-feed-sync.ts'
import { createUserStateCompaction } from './user-state-compaction.ts'

const disposers: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposers.splice(0).map(dispose => dispose()))
})

function tamperCursor(cursor: string) {
  const separator = cursor.lastIndexOf('.')
  assert.notEqual(separator, -1)
  const signature = cursor.slice(separator + 1)
  const replacement = signature.startsWith('A') ? 'B' : 'A'
  return `${cursor.slice(0, separator + 1)}${replacement}${signature.slice(1)}`
}

describe('Local Feed Sync', () => {
  it('fails closed when an internal user has multiple GitHub account owners', async () => {
    const testDatabase = await createTestDatabase({
      throughMigration: '0014_overrated_shaman.sql',
    })
    disposers.push(testDatabase.dispose)
    const { database } = testDatabase
    const now = new Date('2026-07-16T12:00:00.000Z')
    await database.insert(user).values({
      id: 'viewer',
      name: 'Viewer',
      email: 'viewer@example.com',
    })
    await database.insert(account).values([
      {
        id: 'github-account-a',
        accountId: '1',
        providerId: 'github',
        userId: 'viewer',
        updatedAt: now,
      },
      {
        id: 'github-account-b',
        accountId: '2',
        providerId: 'github',
        userId: 'viewer',
        updatedAt: now,
      },
    ])

    await assert.rejects(
      createLocalFeedSync({ database }).getManifest('viewer'),
      LocalFeedAuthorizationError,
    )
  })

  it('keeps legacy Worker inserts and deletes inside the Activity sequence fence', async () => {
    const testDatabase = await createTestDatabase({ throughMigration: '0009_damp_tyrannus.sql' })
    disposers.push(testDatabase.dispose)
    const { database } = testDatabase
    const publishedAt = new Date('2026-07-16T11:00:00.000Z')
    await database.insert(githubUser).values({ login: 'alice', id: '1' })

    await database.insert(feedItem).values({
      id: 'legacy-worker-item',
      githubUserLogin: 'alice',
      title: 'Legacy Worker item',
      type: 'PushEvent',
      publishedAt,
    })

    const [storedItem, change] = await Promise.all([
      database.select().from(feedItem).where(eq(feedItem.id, 'legacy-worker-item')).limit(1),
      database
        .select()
        .from(activityChange)
        .where(eq(activityChange.activityId, 'legacy-worker-item'))
        .limit(1),
    ])
    assert.equal(storedItem[0]?.actorKey, 'github:1')
    assert.equal(change[0]?.actorKey, 'github:1')
    assert.ok(change[0]?.seq)

    await database.delete(feedItem).where(eq(feedItem.id, 'legacy-worker-item'))
    const [remainingChanges, retention, syncState] = await Promise.all([
      database
        .select()
        .from(activityChange)
        .where(eq(activityChange.activityId, 'legacy-worker-item')),
      database
        .select()
        .from(activityRetentionState)
        .where(eq(activityRetentionState.actorKey, 'github:1'))
        .limit(1),
      database.select().from(activitySyncState).where(eq(activitySyncState.id, 1)).limit(1),
    ])
    assert.equal(remainingChanges.length, 0)
    assert.equal(retention[0]?.compactedThroughSeq, change[0]?.seq)
    assert.equal(retention[0]?.retentionGeneration, 1)
    assert.equal(syncState[0]?.retentionGeneration, 1)
  })

  it('repairs attributable orphan Activity changes and blocks unattributable ones', async () => {
    const repairableDatabase = await createTestDatabase()
    disposers.push(repairableDatabase.dispose)
    await repairableDatabase.database.insert(activityChange).values({
      activityId: 'missing-feed-item',
      actorKey: 'github:9',
      actorGithubId: '9',
    })

    const repaired = await createActivityReconciliation(repairableDatabase.database).reconcile()
    assert.equal(repaired.repairedOrphanChanges, 1)
    assert.equal(repaired.audit.orphanChanges, 0)
    assert.equal(repaired.audit.ready, true)
    const [repairableChanges, retention, syncState] = await Promise.all([
      repairableDatabase.database.select().from(activityChange),
      repairableDatabase.database
        .select()
        .from(activityRetentionState)
        .where(eq(activityRetentionState.actorKey, 'github:9')),
      repairableDatabase.database
        .select()
        .from(activitySyncState)
        .where(eq(activitySyncState.id, 1)),
    ])
    assert.equal(repairableChanges.length, 0)
    assert.equal(retention[0]?.compactedThroughSeq, 1)
    assert.equal(retention[0]?.retentionGeneration, 1)
    assert.equal(syncState[0]?.retentionGeneration, 1)

    const blockedDatabase = await createTestDatabase()
    disposers.push(blockedDatabase.dispose)
    await blockedDatabase.database.insert(activityChange).values({
      activityId: 'unattributable-change',
      actorKey: '',
    })
    const blocked = await createActivityReconciliation(blockedDatabase.database).reconcile()
    assert.equal(blocked.repairedOrphanChanges, 0)
    assert.equal(blocked.audit.orphanChanges, 1)
    assert.equal(blocked.audit.ready, false)
    assert.equal((await blockedDatabase.database.select().from(activityChange)).length, 1)
  })

  it('identifies the authenticated GitHub viewer in the revision manifest', async () => {
    const testDatabase = await createTestDatabase()
    disposers.push(testDatabase.dispose)
    const { database } = testDatabase
    const now = new Date('2026-07-16T12:00:00.000Z')
    await database.insert(user).values({
      id: 'viewer',
      name: 'Viewer',
      email: 'viewer@example.com',
    })
    await database.insert(account).values({
      id: 'github-account',
      accountId: '38493346',
      providerId: 'github',
      userId: 'viewer',
      updatedAt: now,
    })

    const localFeedSync = createLocalFeedSync({
      database,
      now: () => now,
      serverEpoch: 'test-epoch',
    })

    const manifest = await localFeedSync.getManifest('viewer')
    assert.match(manifest.timeAnchor, /^38493346:test-epoch:1784203200000\./)
    assert.deepEqual(
      { ...manifest, timeAnchor: '<signed>' },
      {
        protocol: 1,
        serverEpoch: 'test-epoch',
        viewerGithubId: '38493346',
        serverTime: now.getTime(),
        timeAnchor: '<signed>',
        activity: { headSeq: '0', retentionGeneration: '0' },
        following: { revision: null, completedAt: null, reauthRequiredAt: null },
        userState: { revision: '0', epoch: 'test-epoch:viewer' },
      },
    )
  })

  it('bridges legacy Worker Filter and clear writes into the User State log', async () => {
    const testDatabase = await createTestDatabase()
    disposers.push(testDatabase.dispose)
    const { database } = testDatabase
    const createdAt = new Date('2026-07-16T12:00:00.000Z')
    await database.insert(user).values({
      id: 'viewer',
      name: 'Viewer',
      email: 'viewer@example.com',
    })
    await database.insert(account).values({
      id: 'github-account',
      accountId: '38493346',
      providerId: 'github',
      userId: 'viewer',
      updatedAt: createdAt,
    })
    const sync = createLocalFeedSync({ database, serverEpoch: 'test-epoch' })
    const bootstrap = await sync.pullUserState('viewer')
    assert.equal(bootstrap.mode, 'snapshot')
    assert.equal(bootstrap.revision, '0')

    await database.insert(userFilter).values({
      id: 'legacy-filter',
      userId: 'viewer',
      name: 'Legacy filter',
      filterRule: JSON.stringify(emptyFilterGroup),
      createdAt,
      updatedAt: createdAt,
    })
    const inserted = await sync.pullUserState('viewer', {
      afterSeq: bootstrap.revision,
      epoch: bootstrap.epoch,
    })
    assert.equal(inserted.mode, 'delta')
    assert.equal(inserted.revision, '1')
    assert.deepEqual(
      inserted.filters.map(filter => ({
        id: filter.id,
        name: filter.name,
        version: filter.version,
        changedRevision: filter.changedRevision,
        deletedAt: filter.deletedAt,
      })),
      [
        {
          id: 'legacy-filter',
          name: 'Legacy filter',
          version: 1,
          changedRevision: '1',
          deletedAt: null,
        },
      ],
    )

    const updatedAt = new Date('2026-07-16T12:01:00.000Z')
    await database
      .update(userFilter)
      .set({ name: 'Legacy filter updated', updatedAt })
      .where(eq(userFilter.id, 'legacy-filter'))
    const updated = await sync.pullUserState('viewer', {
      afterSeq: inserted.revision,
      epoch: bootstrap.epoch,
    })
    assert.equal(updated.revision, '2')
    assert.deepEqual(
      updated.filters.map(filter => ({
        name: filter.name,
        version: filter.version,
        changedRevision: filter.changedRevision,
      })),
      [{ name: 'Legacy filter updated', version: 2, changedRevision: '2' }],
    )

    await database.delete(userFilter).where(eq(userFilter.id, 'legacy-filter'))
    const deleted = await sync.pullUserState('viewer', {
      afterSeq: updated.revision,
      epoch: bootstrap.epoch,
    })
    assert.equal(deleted.revision, '3')
    assert.equal(deleted.filters[0]?.version, 3)
    assert.equal(deleted.filters[0]?.changedRevision, '3')
    assert.ok(deleted.filters[0]?.deletedAt)

    const firstClear = new Date('2026-07-16T12:02:00.000Z')
    await database.insert(userFeedState).values({
      userId: 'viewer',
      activityClearedAt: firstClear,
    })
    const cleared = await sync.pullUserState('viewer', {
      afterSeq: deleted.revision,
      epoch: bootstrap.epoch,
    })
    assert.equal(cleared.revision, '4')
    assert.deepEqual(cleared.feedState, {
      activityClearedAt: firstClear.getTime(),
      version: 1,
      changedRevision: '4',
    })

    const secondClear = new Date('2026-07-16T12:03:00.000Z')
    await database
      .insert(userFeedState)
      .values({ userId: 'viewer', activityClearedAt: secondClear })
      .onConflictDoUpdate({
        target: userFeedState.userId,
        set: { activityClearedAt: secondClear },
      })
    const clearedAgain = await sync.pullUserState('viewer', {
      afterSeq: cleared.revision,
      epoch: bootstrap.epoch,
    })
    assert.equal(clearedAgain.revision, '5')
    assert.deepEqual(clearedAgain.feedState, {
      activityClearedAt: secondClear.getTime(),
      version: 2,
      changedRevision: '5',
    })

    await database
      .update(userFeedState)
      .set({ activityClearedAt: firstClear })
      .where(eq(userFeedState.userId, 'viewer'))
    assert.equal((await sync.getManifest('viewer')).userState.revision, '5')
    assert.equal(
      (await sync.pullUserState('viewer')).feedState.activityClearedAt,
      secondClear.getTime(),
    )
  })

  it('keeps selected-actor scope checkpoints stable across Following revisions', async () => {
    const testDatabase = await createTestDatabase()
    disposers.push(testDatabase.dispose)
    const { database } = testDatabase
    const now = new Date('2026-07-16T12:00:00.000Z')
    await database.insert(user).values({
      id: 'viewer',
      name: 'Viewer',
      email: 'viewer@example.com',
    })
    await database.insert(account).values({
      id: 'github-account',
      accountId: '38493346',
      providerId: 'github',
      userId: 'viewer',
      updatedAt: now,
    })
    const followingSync = createFollowingSync({
      database,
      getAccessToken: async () => 'secret-token',
      getFollowing: async () => [{ id: '1', login: 'alice' }],
    })
    const localFeedSync = createLocalFeedSync({ database })

    await followingSync.sync('viewer')
    const firstRevision = (await localFeedSync.getManifest('viewer')).following.revision
    assert.ok(firstRevision)
    const firstFollowing = await localFeedSync.getActivityHistoryPage('viewer', {
      scope: { kind: 'following', followingRevision: firstRevision },
    })
    const firstActors = await localFeedSync.getActivityHistoryPage('viewer', {
      scope: { kind: 'actors', actorKeys: ['github:1'] },
    })

    await followingSync.sync('viewer')
    const secondRevision = (await localFeedSync.getManifest('viewer')).following.revision
    assert.ok(secondRevision)
    assert.notEqual(secondRevision, firstRevision)
    const secondFollowing = await localFeedSync.getActivityHistoryPage('viewer', {
      scope: { kind: 'following', followingRevision: secondRevision },
    })
    const secondActors = await localFeedSync.getActivityHistoryPage('viewer', {
      scope: { kind: 'actors', actorKeys: ['github:1'] },
    })

    assert.equal(firstActors.scopeKey, secondActors.scopeKey)
    assert.notEqual(firstFollowing.scopeKey, secondFollowing.scopeKey)
  })

  it('delivers a late Atom entry through the ingestion-sequence delta', async () => {
    const testDatabase = await createTestDatabase()
    disposers.push(testDatabase.dispose)
    const { database } = testDatabase
    let now = new Date('2026-07-16T12:00:00.000Z')
    await database.insert(user).values({
      id: 'viewer',
      name: 'Viewer',
      email: 'viewer@example.com',
    })
    await database.insert(account).values({
      id: 'github-account',
      accountId: '38493346',
      providerId: 'github',
      userId: 'viewer',
      updatedAt: now,
    })
    await createFollowingSync({
      database,
      getAccessToken: async () => 'secret-token',
      getFollowing: async () => [{ id: '1', login: 'alice' }],
    }).sync('viewer')

    let request = 0
    const refresh = createFeedRefresh({
      database,
      now: () => now,
      getActivity: async () => {
        request += 1
        const activity =
          request === 1
            ? {
                id: 'newer-publication',
                title: 'newer publication',
                publishedAtMs: Date.parse('2026-07-16T11:00:00.000Z'),
              }
            : {
                id: 'late-old-publication',
                title: 'late old publication',
                publishedAtMs: Date.parse('2026-07-10T11:00:00.000Z'),
              }
        return {
          githubId: '1',
          items: [
            {
              ...activity,
              link: null,
              repo: 'alice/project',
              type: 'push',
              summary: null,
              content: null,
            },
          ],
        }
      },
    })
    await refresh.refreshOne('viewer', 'alice')

    const localFeedSync = createLocalFeedSync({ database })
    const firstManifest = await localFeedSync.getManifest('viewer')
    assert.ok(firstManifest.following.revision)
    const history = await localFeedSync.getActivityHistoryPage('viewer', {
      scope: { kind: 'following', followingRevision: firstManifest.following.revision },
      targetThroughSeq: firstManifest.activity.headSeq,
      limit: 20,
    })
    assert.deepEqual(
      history.items.map(item => item.id),
      ['newer-publication'],
    )
    const detail = await localFeedSync.getActivityById('viewer', 'newer-publication')
    assert.equal(detail.result.kind, 'found')
    assert.equal(
      (await localFeedSync.getActivityById('viewer', 'not-retained')).result.kind,
      'cloud-miss',
    )
    await database.insert(feedItem).values({
      id: 'unfollowed-activity',
      githubUserLogin: 'mallory',
      actorKey: 'github:2',
      actorGithubId: '2',
      title: 'unfollowed',
      type: 'push',
      publishedAt: now,
    })
    assert.equal(
      (await localFeedSync.getActivityById('viewer', 'unfollowed-activity')).result.kind,
      'not-authorized',
    )

    now = new Date('2026-07-16T12:06:00.000Z')
    await refresh.refreshOne('viewer', 'alice')
    const secondManifest = await localFeedSync.getManifest('viewer')
    const delta = await localFeedSync.getActivityDeltaPage('viewer', {
      scope: { kind: 'following', followingRevision: firstManifest.following.revision },
      fromSeq: firstManifest.activity.headSeq,
      targetThroughSeq: secondManifest.activity.headSeq,
      limit: 20,
    })

    assert.deepEqual(
      delta.items.map(item => item.id),
      ['late-old-publication'],
    )
    assert.equal(delta.throughSeq, secondManifest.activity.headSeq)
    assert.equal(delta.nextCursor, null)
    const readRetention = () =>
      database
        .select({
          publishedAt: activityRetentionState.oldestRetainedPublishedAt,
          activityId: activityRetentionState.oldestRetainedActivityId,
        })
        .from(activityRetentionState)
        .where(eq(activityRetentionState.actorKey, 'github:1'))
    assert.deepEqual(await readRetention(), [
      {
        publishedAt: new Date('2026-07-10T11:00:00.000Z'),
        activityId: 'late-old-publication',
      },
    ])

    await database
      .update(activityRetentionState)
      .set({
        oldestRetainedPublishedAt: new Date('2026-07-16T11:00:00.000Z'),
        oldestRetainedActivityId: 'newer-publication',
      })
      .where(eq(activityRetentionState.actorKey, 'github:1'))
    await createActivityReconciliation(database).reconcile(now)
    assert.deepEqual(await readRetention(), [
      {
        publishedAt: new Date('2026-07-10T11:00:00.000Z'),
        activityId: 'late-old-publication',
      },
    ])
  })

  it('rejects tampered cursors for every paged sync stream', async () => {
    const testDatabase = await createTestDatabase()
    disposers.push(testDatabase.dispose)
    const { database } = testDatabase
    const now = new Date('2026-07-16T12:00:00.000Z')
    await database.insert(user).values({
      id: 'viewer',
      name: 'Viewer',
      email: 'viewer@example.com',
    })
    await database.insert(account).values({
      id: 'github-account',
      accountId: '38493346',
      providerId: 'github',
      userId: 'viewer',
      updatedAt: now,
    })
    await createFollowingSync({
      database,
      getAccessToken: async () => 'secret-token',
      getFollowing: async () => [
        { id: '1', login: 'alice' },
        { id: '2', login: 'bob' },
      ],
    }).sync('viewer')
    await createFeedRefresh({
      database,
      now: () => now,
      getActivity: async () => ({
        githubId: '1',
        items: ['activity-a', 'activity-b'].map(id => ({
          id,
          title: id,
          link: null,
          repo: null,
          type: 'push',
          publishedAtMs: now.getTime(),
          summary: null,
          content: null,
        })),
      }),
    }).refreshOne('viewer', 'alice')

    const localFeedSync = createLocalFeedSync({
      database,
      timeAnchorSecret: 'cursor-test-secret',
    })
    const manifest = await localFeedSync.getManifest('viewer')
    assert.ok(manifest.following.revision)

    const followingPage = await localFeedSync.getFollowingPage('viewer', {
      revision: manifest.following.revision,
      limit: 1,
    })
    assert.ok(followingPage.nextCursor)
    await assert.rejects(
      localFeedSync.getFollowingPage('viewer', {
        revision: manifest.following.revision,
        cursor: tamperCursor(followingPage.nextCursor),
        limit: 1,
      }),
      LocalFeedCursorError,
    )

    const scope = {
      kind: 'following' as const,
      followingRevision: manifest.following.revision,
    }
    const historyPage = await localFeedSync.getActivityHistoryPage('viewer', {
      scope,
      targetThroughSeq: manifest.activity.headSeq,
      limit: 1,
    })
    assert.ok(historyPage.nextCursor)
    await assert.rejects(
      localFeedSync.getActivityHistoryPage('viewer', {
        scope,
        cursor: tamperCursor(historyPage.nextCursor),
        targetThroughSeq: manifest.activity.headSeq,
        limit: 1,
      }),
      LocalFeedCursorError,
    )

    const deltaPage = await localFeedSync.getActivityDeltaPage('viewer', {
      scope,
      fromSeq: '0',
      targetThroughSeq: manifest.activity.headSeq,
      limit: 1,
    })
    assert.ok(deltaPage.nextCursor)
    await assert.rejects(
      localFeedSync.getActivityDeltaPage('viewer', {
        scope,
        fromSeq: '0',
        cursor: tamperCursor(deltaPage.nextCursor),
        targetThroughSeq: manifest.activity.headSeq,
        limit: 1,
      }),
      LocalFeedCursorError,
    )
  })

  it('reports a retention gap without reducing the activity head sequence', async () => {
    const testDatabase = await createTestDatabase()
    disposers.push(testDatabase.dispose)
    const { database } = testDatabase
    const now = new Date('2026-07-16T12:00:00.000Z')
    await database.insert(user).values({
      id: 'viewer',
      name: 'Viewer',
      email: 'viewer@example.com',
    })
    await database.insert(account).values({
      id: 'github-account',
      accountId: '38493346',
      providerId: 'github',
      userId: 'viewer',
      updatedAt: now,
    })
    await createFollowingSync({
      database,
      getAccessToken: async () => 'secret-token',
      getFollowing: async () => [{ id: '1', login: 'alice' }],
    }).sync('viewer')
    await createFeedRefresh({
      database,
      now: () => now,
      getActivity: async () => ({
        githubId: '1',
        items: ['a', 'b', 'c'].map(id => ({
          id,
          title: id,
          link: null,
          repo: null,
          type: 'push',
          publishedAtMs: Date.parse('2026-07-16T11:00:00.000Z'),
          summary: null,
          content: null,
        })),
      }),
    }).refreshOne('viewer', 'alice')

    const cleanup = createActivityCleanup(database)
    const gated = await cleanup.cleanup(2)
    assert.equal(gated.deleted, 0)
    assert.equal('skipped' in gated ? gated.skipped : null, 'rollout-gate')

    const reconciliation = await createActivityReconciliation(database).reconcile(now)
    assert.equal(reconciliation.audit.ready, true)
    assert.deepEqual(await cleanup.cleanup(2), { deleted: 1 })
    const localFeedSync = createLocalFeedSync({ database })
    const manifest = await localFeedSync.getManifest('viewer')
    assert.ok(manifest.following.revision)
    assert.equal(manifest.activity.headSeq, '3')
    const history = await localFeedSync.getActivityHistoryPage('viewer', {
      scope: { kind: 'following', followingRevision: manifest.following.revision },
      limit: 20,
    })
    assert.deepEqual(
      history.items.map(item => item.id),
      ['c', 'b'],
    )
    const delta = await localFeedSync.getActivityDeltaPage('viewer', {
      scope: { kind: 'following', followingRevision: manifest.following.revision },
      fromSeq: '0',
      limit: 20,
    })
    assert.deepEqual(delta.gap, { compactedThroughSeq: '1' })
  })

  it('only batches over-limit actors and uses the actor retention index', async () => {
    const testDatabase = await createTestDatabase()
    disposers.push(testDatabase.dispose)
    const { database } = testDatabase
    const now = new Date('2026-07-16T12:00:00.000Z')
    await database.insert(githubUser).values([
      { id: '1', login: 'alice' },
      { id: '2', login: 'bob' },
    ])
    await database.insert(feedItem).values([
      {
        id: 'alice-only',
        githubUserLogin: 'alice',
        actorKey: 'github:1',
        actorGithubId: '1',
        title: 'alice only',
        type: 'push',
        publishedAt: now,
      },
      ...['old', 'new'].map((age, index) => ({
        id: `bob-${age}`,
        githubUserLogin: 'bob',
        actorKey: 'github:2',
        actorGithubId: '2',
        title: `bob ${age}`,
        type: 'push',
        publishedAt: new Date(now.getTime() - (2 - index) * 60_000),
      })),
    ])
    assert.equal((await createActivityReconciliation(database).reconcile(now)).audit.ready, true)

    let actorBatches = 0
    const cleanupDatabase = new Proxy(database, {
      get(target, property, receiver) {
        if (property === 'batch') {
          return async (queries: Parameters<typeof database.batch>[0]) => {
            actorBatches += 1
            return database.batch(queries)
          }
        }
        const value = Reflect.get(target, property, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    assert.deepEqual(await createActivityCleanup(cleanupDatabase).cleanup(1), { deleted: 1 })
    assert.equal(actorBatches, 1)
    assert.deepEqual(
      await database.select({ id: feedItem.id }).from(feedItem).orderBy(asc(feedItem.id)),
      [{ id: 'alice-only' }, { id: 'bob-new' }],
    )

    const plan = await database.all<{ detail: string }>(sql`
      explain query plan
      select ${feedItem.id}
      from ${feedItem}
      where ${feedItem.actorKey} = 'github:2'
      order by ${feedItem.publishedAt} desc, ${feedItem.id} desc
      limit -1 offset 1
    `)
    assert.ok(
      plan.some(step => step.detail.includes('feed_item_actor_key_published_at_id_idx')),
      JSON.stringify(plan),
    )
    assert.equal(
      plan.some(step => step.detail.includes('USE TEMP B-TREE')),
      false,
      JSON.stringify(plan),
    )
  })

  it('pages Following history in publication order without a temporary sort', async () => {
    const testDatabase = await createTestDatabase()
    disposers.push(testDatabase.dispose)
    const { database } = testDatabase

    const plan = await database.all<{ detail: string }>(sql`
      explain query plan
      select ${feedItem.id}
      from ${feedItem}
      inner join ${activityChange}
        on ${activityChange.source} = ${feedItem.source}
        and ${activityChange.activityId} = ${feedItem.id}
      where ${feedItem.actorKey} in (
        select value from json_each('["github:1","github:2"]')
      )
        and ${feedItem.hidden} = 0
        and ${activityChange.seq} <= 100
      order by ${feedItem.publishedAt} desc, ${feedItem.id} desc
      limit 251
    `)

    assert.equal(
      plan.some(step => step.detail.includes('USE TEMP B-TREE')),
      false,
      JSON.stringify(plan),
    )
    assert.ok(
      plan.some(step => step.detail.includes('feed_item_hidden_published_at_id_idx')),
      JSON.stringify(plan),
    )
  })

  it('stops cleanup when the rollout gate changes between actor batches', async () => {
    const testDatabase = await createTestDatabase()
    disposers.push(testDatabase.dispose)
    const { database } = testDatabase
    const now = new Date('2026-07-16T12:00:00.000Z')
    const actors = [
      { githubId: '1', login: 'alice' },
      { githubId: '2', login: 'bob' },
      { githubId: '3', login: 'carol' },
    ]
    await database.insert(githubUser).values(
      actors.map(actor => ({
        id: actor.githubId,
        login: actor.login,
      })),
    )
    await database.insert(feedItem).values(
      actors.flatMap(actor =>
        ['old', 'new'].map((age, index) => ({
          id: `${actor.login}-${age}`,
          githubUserLogin: actor.login,
          actorKey: `github:${actor.githubId}`,
          actorGithubId: actor.githubId,
          title: `${actor.login} ${age}`,
          type: 'push',
          publishedAt: new Date(now.getTime() - (2 - index) * 60_000),
        })),
      ),
    )
    assert.equal((await createActivityReconciliation(database).reconcile(now)).audit.ready, true)

    let actorBatch = 0
    const cleanupDatabase = new Proxy(database, {
      get(target, property, receiver) {
        if (property === 'batch') {
          return async (queries: Parameters<typeof database.batch>[0]) => {
            actorBatch += 1
            if (actorBatch === 2) {
              await database
                .update(localFeedServerState)
                .set({ dataEpoch: 'rotated-during-cleanup' })
                .where(eq(localFeedServerState.id, 1))
            }
            return database.batch(queries)
          }
        }
        const value = Reflect.get(target, property, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })

    assert.deepEqual(await createActivityCleanup(cleanupDatabase).cleanup(1), { deleted: 1 })
    assert.equal(actorBatch, 2)
    assert.deepEqual(
      await database.select({ id: feedItem.id }).from(feedItem).orderBy(asc(feedItem.id)),
      [
        { id: 'alice-new' },
        { id: 'bob-new' },
        { id: 'bob-old' },
        { id: 'carol-new' },
        { id: 'carol-old' },
      ],
    )
    assert.deepEqual(
      await database
        .select({ activityId: activityChange.activityId })
        .from(activityChange)
        .orderBy(asc(activityChange.activityId)),
      [
        { activityId: 'alice-new' },
        { activityId: 'bob-new' },
        { activityId: 'bob-old' },
        { activityId: 'carol-new' },
        { activityId: 'carol-old' },
      ],
    )
    assert.deepEqual(
      await database
        .select({
          actorKey: activityRetentionState.actorKey,
          generation: activityRetentionState.retentionGeneration,
        })
        .from(activityRetentionState)
        .orderBy(asc(activityRetentionState.actorKey)),
      [
        { actorKey: 'github:1', generation: 1 },
        { actorKey: 'github:2', generation: 0 },
        { actorKey: 'github:3', generation: 0 },
      ],
    )
    assert.equal(
      (
        await database
          .select({ generation: activitySyncState.retentionGeneration })
          .from(activitySyncState)
          .where(eq(activitySyncState.id, 1))
      )[0]?.generation,
      1,
    )
  })

  it('acknowledges filter CAS attempts exactly once and never resurrects a tombstone', async () => {
    const testDatabase = await createTestDatabase()
    disposers.push(testDatabase.dispose)
    const { database } = testDatabase
    const now = new Date('2026-07-16T12:00:00.000Z')
    await database.insert(user).values({
      id: 'viewer',
      name: 'Viewer',
      email: 'viewer@example.com',
    })
    await database.insert(account).values({
      id: 'github-account',
      accountId: '38493346',
      providerId: 'github',
      userId: 'viewer',
      updatedAt: now,
    })
    const filterRule = {
      id: 'hide-stars',
      type: 'FilterGroup',
      op: 'and',
      conditions: [
        {
          id: 'type-is-star',
          type: 'Filter',
          path: ['type'],
          name: 'equals',
          args: ['star'],
        },
      ],
    } as FilterGroup
    const localFeedSync = createLocalFeedSync({ database, now: () => now })
    const put = {
      kind: 'filter.put' as const,
      mutationId: 'mutation-put',
      attemptId: 'attempt-put',
      baseVersion: 0,
      filter: { id: 'filter-1', name: 'Hide stars', filterRule },
    }

    const applied = await localFeedSync.pushUserMutation('viewer', put)
    assert.equal(applied.kind, 'applied')
    assert.equal(applied.replica.version, 1)
    const replay = await localFeedSync.pushUserMutation('viewer', put)
    assert.equal(replay.kind, 'already-applied')

    const conflict = await localFeedSync.pushUserMutation('viewer', {
      ...put,
      mutationId: 'stale-mutation',
      attemptId: 'stale-attempt',
      filter: { ...put.filter, name: 'Stale name' },
    })
    assert.equal(conflict.kind, 'conflict')
    assert.equal(conflict.currentReplica?.version, 1)

    const deleted = await localFeedSync.pushUserMutation('viewer', {
      kind: 'filter.delete',
      mutationId: 'mutation-delete',
      attemptId: 'attempt-delete',
      baseVersion: 1,
      id: 'filter-1',
    })
    assert.equal(deleted.kind, 'applied')
    assert.equal(deleted.entityKind, 'filter')
    if (deleted.entityKind !== 'filter') {
      assert.fail('Expected an applied Filter tombstone')
    }
    assert.equal(deleted.replica.version, 2)
    assert.equal(deleted.replica.deletedAt, now.getTime())

    const resurrection = await localFeedSync.pushUserMutation('viewer', {
      ...put,
      mutationId: 'resurrection',
      attemptId: 'resurrection-attempt',
      baseVersion: 2,
    })
    assert.equal(resurrection.kind, 'conflict')
    assert.equal(resurrection.entityKind, 'filter')
    if (resurrection.entityKind !== 'filter') {
      assert.fail('Expected a Filter conflict')
    }
    assert.equal(resurrection.currentReplica?.deletedAt, now.getTime())

    const userStateManifest = await localFeedSync.getManifest('viewer')
    const pulled = await localFeedSync.pullUserState('viewer', {
      afterSeq: '0',
      epoch: userStateManifest.userState.epoch,
    })
    assert.equal(pulled.mode, 'delta')
    assert.equal(pulled.filters[0]?.version, 2)
    assert.equal(pulled.filters[0]?.deletedAt, now.getTime())
  })

  it('preserves malformed legacy Filter values through snapshots, deletion, and receipt replay', async () => {
    const testDatabase = await createTestDatabase()
    disposers.push(testDatabase.dispose)
    const { database } = testDatabase
    const now = new Date('2026-07-16T12:00:00.000Z')
    await database.insert(user).values({
      id: 'viewer',
      name: 'Viewer',
      email: 'viewer@example.com',
    })
    await database.insert(account).values({
      id: 'github-account',
      accountId: '38493346',
      providerId: 'github',
      userId: 'viewer',
      updatedAt: now,
    })
    const localFeedSync = createLocalFeedSync({ database, now: () => now })
    await localFeedSync.getManifest('viewer')
    await database.insert(userFilter).values([
      {
        id: 'legacy-malformed',
        userId: 'viewer',
        name: 'Malformed legacy Filter',
        filterRule: '{not-json',
      },
      {
        id: 'legacy-invalid-schema',
        userId: 'viewer',
        name: 'Invalid legacy Filter schema',
        filterRule: JSON.stringify({ legacy: true }),
      },
    ])

    const snapshot = await localFeedSync.pullUserState('viewer')
    assert.equal(snapshot.mode, 'snapshot')
    assert.deepEqual(
      snapshot.filters.map(filter => [filter.id, filter.filterRule]),
      [
        ['legacy-malformed', '{not-json'],
        ['legacy-invalid-schema', { legacy: true }],
      ],
    )

    const deletion = {
      kind: 'filter.delete' as const,
      mutationId: 'delete-malformed',
      attemptId: 'delete-malformed-attempt',
      baseVersion: 1,
      id: 'legacy-malformed',
    }
    const applied = await localFeedSync.pushUserMutation('viewer', deletion)
    assert.equal(applied.kind, 'applied')
    assert.equal(applied.entityKind, 'filter')
    if (applied.entityKind !== 'filter') assert.fail('Expected a Filter result')
    assert.equal(applied.replica.filterRule, '{not-json')
    assert.equal(applied.replica.deletedAt, now.getTime())

    const replay = await localFeedSync.pushUserMutation('viewer', deletion)
    assert.equal(replay.kind, 'already-applied')
    assert.equal(replay.entityKind, 'filter')
    if (replay.entityKind !== 'filter') assert.fail('Expected a Filter result')
    assert.equal(replay.replica.filterRule, '{not-json')

    await database
      .delete(userMutationReceipt)
      .where(eq(userMutationReceipt.attemptId, deletion.attemptId))
    const reconstructedReplay = await localFeedSync.pushUserMutation('viewer', deletion)
    assert.equal(reconstructedReplay.kind, 'already-applied')
    assert.equal(reconstructedReplay.entityKind, 'filter')
    if (reconstructedReplay.entityKind !== 'filter') assert.fail('Expected a Filter result')
    assert.equal(reconstructedReplay.replica.filterRule, '{not-json')

    const dateFilterRule = {
      id: 'before-date',
      type: 'FilterGroup',
      op: 'and',
      conditions: [
        {
          id: 'published-before',
          type: 'Filter',
          path: ['publishedAt'],
          name: 'before',
          args: [new Date('2026-07-01T00:00:00.000Z')],
        },
      ],
    } as FilterGroup
    const dateMutation = {
      kind: 'filter.put' as const,
      mutationId: 'put-date-filter',
      attemptId: 'put-date-filter-attempt',
      baseVersion: 0,
      filter: { id: 'date-filter', name: 'Before date', filterRule: dateFilterRule },
    }
    assert.equal((await localFeedSync.pushUserMutation('viewer', dateMutation)).kind, 'applied')
    await database
      .delete(userMutationReceipt)
      .where(eq(userMutationReceipt.attemptId, dateMutation.attemptId))
    const dateReplay = await localFeedSync.pushUserMutation('viewer', dateMutation)
    assert.equal(dateReplay.kind, 'already-applied')
    assert.equal(dateReplay.entityKind, 'filter')
    if (dateReplay.entityKind !== 'filter') assert.fail('Expected a Filter result')
    assert.deepEqual(dateReplay.replica.filterRule, dateFilterRule)
  })

  it('compacts user-state logs and pages a stable canonical snapshot', async () => {
    const testDatabase = await createTestDatabase()
    disposers.push(testDatabase.dispose)
    const { database } = testDatabase
    const now = new Date('2026-07-16T12:00:00.000Z')
    await database.insert(user).values({
      id: 'viewer',
      name: 'Viewer',
      email: 'viewer@example.com',
    })
    await database.insert(account).values({
      id: 'github-account',
      accountId: '38493346',
      providerId: 'github',
      userId: 'viewer',
      updatedAt: now,
    })
    const filterRule = {
      id: 'hide-stars',
      type: 'FilterGroup',
      op: 'and',
      conditions: [
        {
          id: 'type-is-star',
          type: 'Filter',
          path: ['type'],
          name: 'equals',
          args: ['star'],
        },
      ],
    } as FilterGroup
    const localFeedSync = createLocalFeedSync({ database, now: () => now })
    const initialManifest = await localFeedSync.getManifest('viewer')
    const firstAttempt = {
      kind: 'filter.put' as const,
      mutationId: 'filter-1-create',
      attemptId: 'filter-1-create-attempt',
      baseVersion: 0,
      filter: { id: 'filter-1', name: 'First', filterRule },
    }
    assert.equal((await localFeedSync.pushUserMutation('viewer', firstAttempt)).kind, 'applied')
    assert.equal(
      (
        await localFeedSync.pushUserMutation('viewer', {
          ...firstAttempt,
          mutationId: 'filter-1-update',
          attemptId: 'filter-1-update-attempt',
          baseVersion: 1,
          filter: { ...firstAttempt.filter, name: 'Second' },
        })
      ).kind,
      'applied',
    )
    const latestAttempt = {
      ...firstAttempt,
      mutationId: 'filter-1-latest',
      attemptId: 'filter-1-latest-attempt',
      baseVersion: 2,
      filter: { ...firstAttempt.filter, name: 'Third' },
    }
    assert.equal((await localFeedSync.pushUserMutation('viewer', latestAttempt)).kind, 'applied')
    for (const id of ['filter-2', 'filter-3']) {
      // oxlint-disable-next-line react-doctor/async-await-in-loop
      const result = await localFeedSync.pushUserMutation('viewer', {
        kind: 'filter.put',
        mutationId: `${id}-create`,
        attemptId: `${id}-create-attempt`,
        baseVersion: 0,
        filter: { id, name: id, filterRule },
      })
      assert.equal(result.kind, 'applied')
    }

    assert.deepEqual(await createUserStateCompaction(database).compact(2, 0), {
      advancedFloors: 1,
      deletedChanges: 3,
      deletedReceipts: 5,
    })
    const [syncState, retainedChanges, retainedReceipts] = await Promise.all([
      database.select().from(userStateSyncState).where(eq(userStateSyncState.userId, 'viewer')),
      database.select().from(userStateChange),
      database.select().from(userMutationReceipt),
    ])
    assert.equal(syncState[0]?.compactedThroughSeq, 3)
    assert.equal(retainedChanges.length, 2)
    assert.equal(retainedReceipts.length, 0)

    assert.equal(
      (await localFeedSync.pushUserMutation('viewer', latestAttempt)).kind,
      'already-applied',
    )
    const staleReplay = await localFeedSync.pushUserMutation('viewer', firstAttempt)
    assert.equal(staleReplay.kind, 'conflict')
    assert.equal(staleReplay.currentReplica?.version, 3)

    const firstPage = await localFeedSync.pullUserState('viewer', {
      afterSeq: '0',
      epoch: initialManifest.userState.epoch,
      limit: 1,
    })
    assert.equal(firstPage.mode, 'snapshot')
    assert.equal(firstPage.revision, '5')
    assert.ok(firstPage.nextCursor)
    await assert.rejects(
      localFeedSync.pullUserState('viewer', {
        afterSeq: tamperCursor(firstPage.nextCursor),
        epoch: initialManifest.userState.epoch,
        limit: 1,
      }),
      LocalFeedCursorError,
    )

    assert.equal(
      (
        await localFeedSync.pushUserMutation('viewer', {
          ...latestAttempt,
          mutationId: 'filter-1-after-snapshot',
          attemptId: 'filter-1-after-snapshot-attempt',
          baseVersion: 3,
          filter: { ...latestAttempt.filter, name: 'Fourth' },
        })
      ).kind,
      'applied',
    )
    assert.equal(
      (
        await localFeedSync.pushUserMutation('viewer', {
          kind: 'filter.put',
          mutationId: 'filter-4-create',
          attemptId: 'filter-4-create-attempt',
          baseVersion: 0,
          filter: { id: 'filter-4', name: 'filter-4', filterRule },
        })
      ).kind,
      'applied',
    )

    const snapshotFilters = [...firstPage.filters]
    let cursor = firstPage.nextCursor
    for (let pageCount = 0; pageCount < 10; pageCount += 1) {
      // oxlint-disable-next-line react-doctor/async-await-in-loop
      const page = await localFeedSync.pullUserState('viewer', {
        afterSeq: cursor,
        epoch: initialManifest.userState.epoch,
        limit: 1,
      })
      assert.equal(page.mode, 'snapshot')
      assert.equal(page.revision, firstPage.revision)
      assert.ok(page.filters.length <= 1)
      snapshotFilters.push(...page.filters)
      if (!page.nextCursor) {
        break
      }
      cursor = page.nextCursor
    }
    assert.deepEqual(
      snapshotFilters.map(filter => filter.id),
      ['filter-1', 'filter-2', 'filter-3', 'filter-4'],
    )

    const catchUp = await localFeedSync.pullUserState('viewer', {
      afterSeq: firstPage.revision,
      epoch: initialManifest.userState.epoch,
      limit: 10,
    })
    assert.equal(catchUp.mode, 'delta')
    assert.equal(catchUp.revision, '7')
    assert.deepEqual(
      catchUp.filters.map(filter => [filter.id, filter.name]),
      [
        ['filter-1', 'Fourth'],
        ['filter-4', 'filter-4'],
      ],
    )
    assert.equal(
      (
        await database
          .select({ version: userFilter.entityVersion })
          .from(userFilter)
          .where(eq(userFilter.id, 'filter-1'))
      )[0]?.version,
      4,
    )
  })

  it('clamps the clear watermark to server time and converges by maximum', async () => {
    const testDatabase = await createTestDatabase()
    disposers.push(testDatabase.dispose)
    const { database } = testDatabase
    let now = new Date('2026-07-16T12:00:00.000Z')
    await database.insert(user).values({
      id: 'viewer',
      name: 'Viewer',
      email: 'viewer@example.com',
    })
    await database.insert(account).values({
      id: 'github-account',
      accountId: '38493346',
      providerId: 'github',
      userId: 'viewer',
      updatedAt: now,
    })
    const localFeedSync = createLocalFeedSync({ database, now: () => now })
    const manifest = await localFeedSync.getManifest('viewer')
    const first = await localFeedSync.pushUserMutation('viewer', {
      kind: 'feed.clear',
      mutationId: 'clear-1',
      attemptId: 'clear-attempt-1',
      baseVersion: 0,
      candidate: now.getTime() + 86_400_000,
      timeAnchor: manifest.timeAnchor,
    })
    assert.equal(first.kind, 'applied')
    assert.equal(first.entityKind, 'feed-state')
    if (first.entityKind !== 'feed-state') {
      assert.fail('Expected an applied clear watermark')
    }
    assert.equal(first.replica.activityClearedAt, now.getTime())
    assert.equal(first.replica.version, 1)

    now = new Date('2026-07-16T13:00:00.000Z')
    const laterManifest = await localFeedSync.getManifest('viewer')
    const second = await localFeedSync.pushUserMutation('viewer', {
      kind: 'feed.clear',
      mutationId: 'clear-2',
      attemptId: 'clear-attempt-2',
      baseVersion: 1,
      candidate: now.getTime(),
      timeAnchor: laterManifest.timeAnchor,
    })
    assert.equal(second.kind, 'applied')
    assert.equal(second.entityKind, 'feed-state')
    if (second.entityKind !== 'feed-state') {
      assert.fail('Expected an acknowledged clear watermark')
    }
    assert.equal(second.replica.activityClearedAt, now.getTime())
    assert.equal(second.replica.version, 2)

    const noOpMutation = {
      kind: 'feed.clear' as const,
      mutationId: 'clear-3',
      attemptId: 'clear-attempt-3',
      baseVersion: 2,
      candidate: manifest.serverTime,
      timeAnchor: manifest.timeAnchor,
    }
    const noOp = await localFeedSync.pushUserMutation('viewer', noOpMutation)
    assert.equal(noOp.kind, 'applied')
    assert.equal(noOp.entityKind, 'feed-state')
    if (noOp.entityKind !== 'feed-state') {
      assert.fail('Expected an acknowledged no-op clear watermark')
    }
    assert.equal(noOp.replica.activityClearedAt, now.getTime())
    assert.equal(noOp.replica.version, 2)
    assert.equal((await localFeedSync.getManifest('viewer')).userState.revision, '2')
    assert.equal(
      (await localFeedSync.pushUserMutation('viewer', noOpMutation)).kind,
      'already-applied',
    )
  })

  it('reconciles an old Worker Activity write into the v1 history', async () => {
    const testDatabase = await createTestDatabase()
    disposers.push(testDatabase.dispose)
    const { database } = testDatabase
    const now = new Date('2026-07-16T12:00:00.000Z')
    await database.insert(user).values({
      id: 'viewer',
      name: 'Viewer',
      email: 'viewer@example.com',
    })
    await database.insert(account).values({
      id: 'github-account',
      accountId: '38493346',
      providerId: 'github',
      userId: 'viewer',
      updatedAt: now,
    })
    await createFollowingSync({
      database,
      getAccessToken: async () => 'secret-token',
      getFollowing: async () => [{ id: '1', login: 'alice' }],
    }).sync('viewer')
    await database.insert(feedItem).values({
      id: 'legacy-worker-write',
      githubUserLogin: 'alice',
      title: 'legacy write',
      type: 'push',
      publishedAt: now,
    })

    await createActivityReconciliation(database).reconcile()
    const localFeedSync = createLocalFeedSync({ database })
    const manifest = await localFeedSync.getManifest('viewer')
    assert.ok(manifest.following.revision)
    assert.equal(manifest.activity.headSeq, '1')
    const history = await localFeedSync.getActivityHistoryPage('viewer', {
      scope: { kind: 'following', followingRevision: manifest.following.revision },
    })
    assert.deepEqual(
      history.items.map(item => ({ id: item.id, actorKey: item.actorKey })),
      [{ id: 'legacy-worker-write', actorKey: 'github:1' }],
    )
  })

  it('never publishes server-hidden Activity through raw sync endpoints', async () => {
    const testDatabase = await createTestDatabase()
    disposers.push(testDatabase.dispose)
    const { database } = testDatabase
    const now = new Date('2026-07-16T12:00:00.000Z')
    await database.insert(user).values({
      id: 'viewer',
      name: 'Viewer',
      email: 'viewer@example.com',
    })
    await database.insert(account).values({
      id: 'github-account',
      accountId: '38493346',
      providerId: 'github',
      userId: 'viewer',
      updatedAt: now,
    })
    await createFollowingSync({
      database,
      getAccessToken: async () => 'secret-token',
      getFollowing: async () => [{ id: '1', login: 'alice' }],
    }).sync('viewer')
    await createFeedRefresh({
      database,
      now: () => now,
      getActivity: async () => ({
        githubId: '1',
        items: [
          {
            id: 'hidden-activity',
            title: 'hidden',
            link: null,
            repo: null,
            type: 'push',
            publishedAtMs: now.getTime(),
            summary: null,
            content: null,
          },
        ],
      }),
    }).refreshOne('viewer', 'alice')
    await database.update(feedItem).set({ hidden: true }).where(eq(feedItem.id, 'hidden-activity'))

    const sync = createLocalFeedSync({ database })
    const manifest = await sync.getManifest('viewer')
    assert.ok(manifest.following.revision)
    const scope = { kind: 'following' as const, followingRevision: manifest.following.revision }
    assert.deepEqual((await sync.getActivityHistoryPage('viewer', { scope })).items, [])
    assert.deepEqual((await sync.getActivityDeltaPage('viewer', { scope, fromSeq: '0' })).items, [])
    assert.equal(
      (await sync.getActivityById('viewer', 'hidden-activity')).result.kind,
      'cloud-miss',
    )
  })

  it('keeps the cleanup gate closed when the dataset epoch rotates after its audit', async () => {
    const testDatabase = await createTestDatabase()
    disposers.push(testDatabase.dispose)
    const { database } = testDatabase
    const now = new Date('2026-07-16T12:00:00.000Z')

    const audit = await markActivityReconciled(database, now, {
      beforeEnable: async () => {
        await database
          .update(localFeedServerState)
          .set({ dataEpoch: 'rotated-after-audit' })
          .where(eq(localFeedServerState.id, 1))
      },
    })

    assert.equal(audit.ready, false)
    assert.deepEqual(
      await database
        .select({
          dataEpoch: localFeedServerState.dataEpoch,
          reconciledAt: localFeedServerState.activityReconciledAt,
          cleanupEnabledAt: localFeedServerState.activityCleanupEnabledAt,
        })
        .from(localFeedServerState)
        .where(eq(localFeedServerState.id, 1)),
      [
        {
          dataEpoch: 'rotated-after-audit',
          reconciledAt: null,
          cleanupEnabledAt: null,
        },
      ],
    )
  })

  it('persists and rotates the dataset epoch across sync instances', async () => {
    const testDatabase = await createTestDatabase()
    disposers.push(testDatabase.dispose)
    const { database } = testDatabase
    const now = new Date('2026-07-16T12:00:00.000Z')
    await database.insert(user).values({
      id: 'viewer',
      name: 'Viewer',
      email: 'viewer@example.com',
    })
    await database.insert(account).values({
      id: 'github-account',
      accountId: '38493346',
      providerId: 'github',
      userId: 'viewer',
      updatedAt: now,
    })
    await createFollowingSync({
      database,
      getAccessToken: async () => 'secret-token',
      getFollowing: async () => [
        { id: '1', login: 'alice' },
        { id: '2', login: 'bob' },
      ],
    }).sync('viewer')

    const firstSync = createLocalFeedSync({ database, timeAnchorSecret: 'epoch-secret' })
    const firstManifest = await firstSync.getManifest('viewer')
    assert.equal(
      (await createLocalFeedSync({ database }).getManifest('viewer')).serverEpoch,
      firstManifest.serverEpoch,
    )
    assert.ok(firstManifest.following.revision)
    const firstPage = await firstSync.getFollowingPage('viewer', {
      revision: firstManifest.following.revision,
      limit: 1,
    })
    assert.ok(firstPage.nextCursor)

    await database
      .update(localFeedServerState)
      .set({ activityReconciledAt: now, activityCleanupEnabledAt: now })
      .where(eq(localFeedServerState.id, 1))
    await database
      .update(localFeedServerState)
      .set({ dataEpoch: 'rotated-dataset' })
      .where(eq(localFeedServerState.id, 1))
    const rotatedSync = createLocalFeedSync({ database, timeAnchorSecret: 'epoch-secret' })
    const rotatedManifest = await rotatedSync.getManifest('viewer')
    assert.equal(rotatedManifest.serverEpoch, 'rotated-dataset')
    assert.equal(rotatedManifest.userState.epoch, 'rotated-dataset:viewer')
    const rotatedState = await database
      .select({
        reconciledAt: localFeedServerState.activityReconciledAt,
        cleanupEnabledAt: localFeedServerState.activityCleanupEnabledAt,
      })
      .from(localFeedServerState)
      .where(eq(localFeedServerState.id, 1))
    assert.equal(rotatedState[0]?.reconciledAt, null)
    assert.equal(rotatedState[0]?.cleanupEnabledAt, null)
    await assert.rejects(
      rotatedSync.getFollowingPage('viewer', {
        revision: firstManifest.following.revision,
        cursor: firstPage.nextCursor,
        limit: 1,
      }),
      LocalFeedCursorError,
    )
  })
})
