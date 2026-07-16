import assert from 'node:assert/strict'

import { account, user } from '@better-github-feed/db/schema/auth'
import {
  followingSnapshot,
  followingSyncState,
  githubUser,
  subscription,
} from '@better-github-feed/db/schema/github'
import { sql } from 'drizzle-orm'
import { afterEach, describe, it } from 'vite-plus/test'

import { createTestDatabase } from '../test/database.ts'
import { createLocalFeedSync } from '../local-feed/local-feed-sync.ts'
import {
  createFollowingSync,
  FollowingAuthorizationError,
  FollowingSyncInProgressError,
  FollowingUnavailableError,
} from './following-sync.ts'

const disposers: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposers.splice(0).map(dispose => dispose()))
})

describe('Following Sync', () => {
  it('fails closed before reading a token when a user has multiple GitHub accounts', async () => {
    const testDatabase = await createTestDatabase({
      throughMigration: '0014_overrated_shaman.sql',
    })
    disposers.push(testDatabase.dispose)
    const { database } = testDatabase
    const now = new Date('2026-07-15T12:00:00.000Z')
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
    let tokenRequests = 0
    const followingSync = createFollowingSync({
      database,
      getAccessToken: async () => {
        tokenRequests += 1
        return 'must-not-be-read'
      },
      getFollowing: async () => [],
    })

    await assert.rejects(followingSync.sync('viewer'), FollowingAuthorizationError)
    assert.equal(tokenRequests, 0)
  })

  it('persists only authorization failures and clears the flag after recovery', async () => {
    const testDatabase = await createTestDatabase()
    disposers.push(testDatabase.dispose)
    const { database } = testDatabase
    let now = new Date('2026-07-15T12:00:00.000Z')
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
    let outcome: 'authorization' | 'unavailable' | 'success' = 'unavailable'
    const followingSync = createFollowingSync({
      database,
      now: () => now,
      getAccessToken: async () => 'secret-token',
      getFollowing: async () => {
        if (outcome === 'authorization') throw new FollowingAuthorizationError()
        if (outcome === 'unavailable') throw new FollowingUnavailableError()
        return [{ id: '1', login: 'alice' }]
      },
    })

    await assert.rejects(followingSync.sync('viewer'), FollowingUnavailableError)
    assert.equal(
      (
        await database
          .select({ reauthRequiredAt: followingSyncState.reauthRequiredAt })
          .from(followingSyncState)
      )[0]?.reauthRequiredAt,
      null,
    )

    outcome = 'authorization'
    now = new Date('2026-07-15T12:01:00.000Z')
    await assert.rejects(followingSync.sync('viewer'), FollowingAuthorizationError)
    assert.equal(
      (await createLocalFeedSync({ database }).getManifest('viewer')).following.reauthRequiredAt,
      now.getTime(),
    )

    outcome = 'unavailable'
    now = new Date('2026-07-15T12:02:00.000Z')
    await assert.rejects(followingSync.sync('viewer'), FollowingUnavailableError)
    assert.equal(
      (await createLocalFeedSync({ database }).getManifest('viewer')).following.reauthRequiredAt,
      Date.parse('2026-07-15T12:01:00.000Z'),
    )

    outcome = 'success'
    await followingSync.sync('viewer')
    assert.equal(
      (await createLocalFeedSync({ database }).getManifest('viewer')).following.reauthRequiredAt,
      null,
    )
  })

  it('waits for an in-flight legacy Worker Following claim', async () => {
    const testDatabase = await createTestDatabase()
    disposers.push(testDatabase.dispose)
    const { database } = testDatabase
    const now = new Date('2026-07-15T12:00:00.000Z')
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
      followingSyncClaimedAt: now,
      updatedAt: now,
    })
    let githubRequests = 0
    const followingSync = createFollowingSync({
      database,
      now: () => now,
      getAccessToken: async () => 'secret-token',
      getFollowing: async () => {
        githubRequests += 1
        return []
      },
    })

    await assert.rejects(followingSync.sync('viewer'), FollowingSyncInProgressError)
    assert.equal(githubRequests, 0)
    assert.equal(
      (await database.select().from(account))[0]?.followingSyncClaimedAt?.getTime(),
      now.getTime(),
    )
  })

  it('holds the legacy Worker claim while a new Following Sync is running', async () => {
    const testDatabase = await createTestDatabase()
    disposers.push(testDatabase.dispose)
    const { database } = testDatabase
    const now = new Date('2026-07-15T12:00:00.000Z')
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
    let legacyClaimChanges = -1
    const followingSync = createFollowingSync({
      database,
      now: () => now,
      getAccessToken: async () => 'secret-token',
      getFollowing: async () => {
        const legacyClaim = await database
          .update(account)
          .set({ followingSyncClaimedAt: new Date(now.getTime() + 1) })
          .where(
            sql`${account.id} = 'github-account' and ${account.followingSyncClaimedAt} is null`,
          )
        legacyClaimChanges = legacyClaim.meta.changes
        return [{ id: '1', login: 'alice' }]
      },
    })

    await followingSync.sync('viewer')
    assert.equal(legacyClaimChanges, 0)
    assert.equal((await database.select().from(account))[0]?.followingSyncClaimedAt, null)
  })

  it('rejects a late promotion after an expired claim is taken by a legacy Worker', async () => {
    const testDatabase = await createTestDatabase()
    disposers.push(testDatabase.dispose)
    const { database } = testDatabase
    let now = new Date('2026-07-15T12:00:00.000Z')
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
    const response = Promise.withResolvers<Array<{ id: string; login: string }>>()
    const started = Promise.withResolvers<void>()
    const followingSync = createFollowingSync({
      database,
      now: () => now,
      getAccessToken: async () => 'secret-token',
      getFollowing: async () => {
        started.resolve()
        return response.promise
      },
    })

    const staleSync = followingSync.sync('viewer')
    await started.promise
    now = new Date('2026-07-15T12:11:00.000Z')
    const legacyClaim = await database.update(account).set({ followingSyncClaimedAt: now })
      .where(sql`
        ${account.id} = 'github-account'
        and ${account.followingSyncClaimedAt} < ${Date.parse('2026-07-15T12:01:00.000Z')}
      `)
    assert.equal(legacyClaim.meta.changes, 1)
    response.resolve([{ id: '1', login: 'alice' }])
    await assert.rejects(staleSync, /superseded/)

    assert.equal((await database.select().from(subscription)).length, 0)
    assert.equal((await database.select().from(followingSyncState))[0]?.activeRevision, null)
    assert.equal(
      (await database.select().from(account))[0]?.followingSyncClaimedAt?.getTime(),
      now.getTime(),
    )
  })

  it('keeps the previous snapshot when GitHub fails', async () => {
    const testDatabase = await createTestDatabase()
    disposers.push(testDatabase.dispose)
    const { database } = testDatabase
    const now = new Date('2026-07-15T12:00:00.000Z')
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

    let attempt = 0
    const followingSync = createFollowingSync({
      database,
      getAccessToken: async () => 'secret-token',
      getFollowing: async () => {
        attempt += 1
        if (attempt === 1) {
          return [
            { id: '1', login: 'alice' },
            { id: '2', login: 'bob' },
          ]
        }
        if (attempt === 2) {
          throw new Error('GitHub unavailable')
        }
        return [{ id: '2', login: 'bob' }]
      },
    })

    assert.deepEqual(await followingSync.sync('viewer'), { total: 2, added: 2, removed: 0 })
    await assert.rejects(followingSync.sync('viewer'), /GitHub unavailable/)
    assert.deepEqual(await followingSync.sync('viewer'), { total: 1, added: 0, removed: 1 })
    assert.deepEqual(await followingSync.sync('viewer'), { total: 1, added: 0, removed: 0 })
    assert.equal((await database.select().from(followingSnapshot)).length, 2)
  })

  it('publishes a complete revision for paged Local Feed bootstrap', async () => {
    const testDatabase = await createTestDatabase()
    disposers.push(testDatabase.dispose)
    const { database } = testDatabase
    const now = new Date('2026-07-15T12:00:00.000Z')
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
      getFollowing: async () => [
        { id: '1', login: 'alice' },
        { id: '2', login: 'bob' },
      ],
    })

    await followingSync.sync('viewer')
    const localFeedSync = createLocalFeedSync({ database })
    const manifest = await localFeedSync.getManifest('viewer')
    assert.ok(manifest.following.revision)

    const first = await localFeedSync.getFollowingPage('viewer', {
      revision: manifest.following.revision,
      limit: 1,
    })
    assert.deepEqual(first.items, [
      {
        actorKey: 'github:1',
        githubId: '1',
        login: 'alice',
        legacyActorKeys: ['legacy-atom-login:alice'],
      },
    ])
    assert.ok(first.nextCursor)
    const second = await localFeedSync.getFollowingPage('viewer', {
      revision: manifest.following.revision,
      cursor: first.nextCursor,
      limit: 1,
    })
    assert.deepEqual(
      second.items.map(item => item.actorKey),
      ['github:2'],
    )
    assert.equal(second.nextCursor, null)
  })

  it('keeps known legacy login keys when a numeric GitHub actor is renamed', async () => {
    const testDatabase = await createTestDatabase()
    disposers.push(testDatabase.dispose)
    const { database } = testDatabase
    const now = new Date('2026-07-15T12:00:00.000Z')
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
    await database.insert(githubUser).values([
      { id: '1', login: 'alice-historical' },
      { id: '9', login: 'unrelated-user' },
    ])
    let login = 'alice'
    const followingSync = createFollowingSync({
      database,
      getAccessToken: async () => 'secret-token',
      getFollowing: async () => [{ id: '1', login }],
    })

    await followingSync.sync('viewer')
    login = 'alice-renamed'
    await followingSync.sync('viewer')

    const manifest = await createLocalFeedSync({ database }).getManifest('viewer')
    assert.ok(manifest.following.revision)
    const page = await createLocalFeedSync({ database }).getFollowingPage('viewer', {
      revision: manifest.following.revision,
    })
    assert.deepEqual(page.items[0]?.legacyActorKeys, [
      'legacy-atom-login:alice',
      'legacy-atom-login:alice-historical',
      'legacy-atom-login:alice-renamed',
    ])
  })

  it('uses the numeric GitHub ID index for legacy alias lookup', async () => {
    const testDatabase = await createTestDatabase()
    disposers.push(testDatabase.dispose)

    const plan = await testDatabase.database.all<{ detail: string }>(sql`
      explain query plan
      select ${githubUser.id}, ${githubUser.login}
      from ${githubUser}
      where ${githubUser.id} in (
        select value from json_each(${JSON.stringify(['1', '2'])})
      )
    `)

    assert.ok(
      plan.some(step => step.detail.includes('USING INDEX github_user_id_idx')),
      JSON.stringify(plan),
    )
    assert.equal(
      plan.some(step => step.detail === 'SCAN github_user'),
      false,
      JSON.stringify(plan),
    )
  })

  it('prevents an expired claim from replacing a newer Following revision', async () => {
    const testDatabase = await createTestDatabase()
    disposers.push(testDatabase.dispose)
    const { database } = testDatabase
    let now = new Date('2026-07-15T12:00:00.000Z')
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
    const oldResponse = Promise.withResolvers<Array<{ id: string; login: string }>>()
    const oldStarted = Promise.withResolvers<void>()
    let request = 0
    const followingSync = createFollowingSync({
      database,
      now: () => now,
      getAccessToken: async () => 'secret-token',
      getFollowing: async () => {
        request += 1
        if (request === 1) {
          oldStarted.resolve()
          return oldResponse.promise
        }
        return [{ id: '2', login: 'bob' }]
      },
    })

    const staleSync = followingSync.sync('viewer')
    await oldStarted.promise
    now = new Date('2026-07-15T12:11:00.000Z')
    await followingSync.sync('viewer')
    oldResponse.resolve([{ id: '1', login: 'alice' }])
    await assert.rejects(staleSync, /superseded/)

    const localFeedSync = createLocalFeedSync({ database })
    const manifest = await localFeedSync.getManifest('viewer')
    assert.ok(manifest.following.revision)
    const page = await localFeedSync.getFollowingPage('viewer', {
      revision: manifest.following.revision,
    })
    assert.deepEqual(
      page.items.map(item => item.login),
      ['bob'],
    )
    assert.deepEqual(
      (await database.select({ login: githubUser.login }).from(githubUser)).map(row => row.login),
      ['bob'],
    )
  })

  it('does not let a stale authorization failure restore a cleared reauth flag', async () => {
    const testDatabase = await createTestDatabase()
    disposers.push(testDatabase.dispose)
    const { database } = testDatabase
    let now = new Date('2026-07-15T12:00:00.000Z')
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
    const staleResponse = Promise.withResolvers<Array<{ id: string; login: string }>>()
    const staleStarted = Promise.withResolvers<void>()
    let request = 0
    const followingSync = createFollowingSync({
      database,
      now: () => now,
      getAccessToken: async () => 'secret-token',
      getFollowing: async () => {
        request += 1
        if (request === 1) {
          staleStarted.resolve()
          return staleResponse.promise
        }
        return [{ id: '2', login: 'bob' }]
      },
    })

    const staleSync = followingSync.sync('viewer')
    await staleStarted.promise
    now = new Date('2026-07-15T12:11:00.000Z')
    await followingSync.sync('viewer')
    staleResponse.reject(new FollowingAuthorizationError())
    await assert.rejects(staleSync, FollowingAuthorizationError)

    assert.equal(
      (
        await database
          .select({ reauthRequiredAt: followingSyncState.reauthRequiredAt })
          .from(followingSyncState)
      )[0]?.reauthRequiredAt,
      null,
    )
  })

  it('publishes an authoritative empty snapshot without treating it as expired', async () => {
    const testDatabase = await createTestDatabase()
    disposers.push(testDatabase.dispose)
    const { database } = testDatabase
    const now = new Date('2026-07-15T12:00:00.000Z')
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
      getFollowing: async () => [],
    }).sync('viewer')

    const sync = createLocalFeedSync({ database })
    const manifest = await sync.getManifest('viewer')
    assert.ok(manifest.following.revision)
    const page = await sync.getFollowingPage('viewer', {
      revision: manifest.following.revision,
    })
    assert.deepEqual(page.items, [])
    assert.equal(page.nextCursor, null)
    const history = await sync.getActivityHistoryPage('viewer', {
      scope: { kind: 'following', followingRevision: manifest.following.revision },
    })
    assert.deepEqual(history.items, [])
    assert.equal(history.remoteWindowEnd, true)
  })
})
