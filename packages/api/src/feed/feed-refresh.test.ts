import assert from 'node:assert/strict'

import { account, user } from '@better-github-feed/db/schema/auth'
import { feedItem, githubUser, subscription } from '@better-github-feed/db/schema/github'
import { afterEach, describe, it } from 'vite-plus/test'

import { createTestDatabase } from '../test/database.ts'
import { createLocalFeedSync } from '../local-feed/local-feed-sync.ts'
import { createFeedRefresh } from './feed-refresh.ts'
import { createVisibleFeed } from './visible-feed.ts'

const disposers: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposers.splice(0).map(dispose => dispose()))
})

describe('Feed Refresh', () => {
  it('reports transport-neutral outcomes for a Following refresh', async () => {
    const testDatabase = await createTestDatabase()
    disposers.push(testDatabase.dispose)
    const { database } = testDatabase
    await database.insert(githubUser).values({ id: '1', login: 'alice' })
    await database.insert(subscription).values({
      id: 'sub-alice',
      userId: 'viewer',
      githubUserLogin: 'alice',
    })
    const feedRefresh = createFeedRefresh({
      database,
      getActivity: async login => ({
        githubId: '1',
        items: [
          {
            id: 'alice-push',
            actor: login,
            title: 'pushed a commit',
            link: null,
            repo: null,
            type: 'push',
            publishedAt: '2026-07-15T11:00:00.000Z',
            publishedAtMs: Date.parse('2026-07-15T11:00:00.000Z'),
            summary: null,
            content: null,
            source: login,
          },
        ],
      }),
    })

    const outcomes = []
    for await (const outcome of feedRefresh.refreshFollowing('viewer')) {
      outcomes.push(outcome)
    }

    assert.deepEqual(
      outcomes.map(outcome => outcome.type),
      ['start', 'refreshed', 'done'],
    )
  })

  it('adds unseen activity without replacing history and enforces cooldown', async () => {
    const testDatabase = await createTestDatabase()
    disposers.push(testDatabase.dispose)
    const { database } = testDatabase
    await database.insert(githubUser).values({ id: '1', login: 'alice' })
    await database.insert(subscription).values({
      id: 'sub-alice',
      userId: 'viewer',
      githubUserLogin: 'alice',
    })

    let now = new Date('2026-07-15T12:00:00.000Z')
    let requestCount = 0
    const feedRefresh = createFeedRefresh({
      database,
      now: () => now,
      getActivity: async login => {
        requestCount += 1
        const item =
          requestCount === 1
            ? {
                id: 'old-push',
                title: 'pushed an old commit',
                type: 'push',
                publishedAt: '2026-07-15T11:00:00.000Z',
                publishedAtMs: Date.parse('2026-07-15T11:00:00.000Z'),
              }
            : {
                id: 'new-star',
                title: 'starred a repository',
                type: 'star',
                publishedAt: '2026-07-15T12:05:00.000Z',
                publishedAtMs: Date.parse('2026-07-15T12:05:00.000Z'),
              }
        return {
          githubId: '1',
          items: [
            {
              actor: login,
              link: null,
              repo: null,
              summary: null,
              content: null,
              source: login,
              ...item,
            },
          ],
        }
      },
    })

    assert.deepEqual(await feedRefresh.refreshOne('viewer', 'alice'), {
      skipped: false,
      refreshedAt: now,
      itemCount: 1,
    })
    assert.deepEqual(await feedRefresh.refreshOne('viewer', 'alice'), { skipped: true })

    now = new Date('2026-07-15T12:06:00.000Z')
    await feedRefresh.refreshOne('viewer', 'alice')
    const page = await createVisibleFeed(database).list({ userId: 'viewer' })

    assert.deepEqual(
      page.items.map(item => item.id),
      ['new-star', 'old-push'],
    )
    assert.equal(requestCount, 2)
  })

  it('assigns one ingestion sequence to a duplicate Atom entry', async () => {
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
    await database.insert(githubUser).values({ id: '1', login: 'alice' })
    await database.insert(subscription).values({
      id: 'sub-alice',
      userId: 'viewer',
      githubUserLogin: 'alice',
    })

    const feedRefresh = createFeedRefresh({
      database,
      now: () => now,
      getActivity: async () => ({
        githubId: '1',
        items: [
          {
            id: 'tag:github.com,2008:PushEvent/1',
            title: 'pushed a commit',
            link: null,
            repo: 'alice/project',
            type: 'push',
            publishedAtMs: Date.parse('2026-07-14T10:00:00.000Z'),
            summary: null,
            content: null,
          },
        ],
      }),
    })

    await feedRefresh.refreshOne('viewer', 'alice')
    now = new Date('2026-07-15T12:06:00.000Z')
    await feedRefresh.refreshOne('viewer', 'alice')

    const manifest = await createLocalFeedSync({ database }).getManifest('viewer')
    assert.equal(manifest.activity.headSeq, '1')
  })

  it('publishes large Atom payloads through bounded atomic chunks', async () => {
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
    await database.insert(githubUser).values({ id: '1', login: 'alice' })
    await database.insert(subscription).values({
      id: 'sub-alice',
      userId: 'viewer',
      githubUserLogin: 'alice',
    })
    const largeContent = 'x'.repeat(32 * 1024)
    const feedRefresh = createFeedRefresh({
      database,
      now: () => now,
      getActivity: async () => ({
        githubId: '1',
        items: Array.from({ length: 17 }, (_, index) => ({
          id: `large-activity-${index}`,
          title: `Activity ${index}`,
          link: null,
          repo: 'alice/project',
          type: 'push',
          publishedAtMs: now.getTime() - index,
          summary: null,
          content: largeContent,
        })),
      }),
    })

    await feedRefresh.refreshOne('viewer', 'alice')

    const rows = await database.select({ content: feedItem.content }).from(feedItem)
    assert.equal(rows.length, 17)
    assert.ok(rows.every(row => row.content === largeContent))
    assert.equal(
      (await createLocalFeedSync({ database }).getManifest('viewer')).activity.headSeq,
      '17',
    )
  })

  it('does not publish Activity from a superseded refresh claim', async () => {
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
    await database.insert(githubUser).values({ id: '1', login: 'alice' })
    await database.insert(subscription).values({
      id: 'sub-alice',
      userId: 'viewer',
      githubUserLogin: 'alice',
    })
    const oldResponse = Promise.withResolvers<{
      githubId: string
      items: Array<{
        id: string
        title: string
        link: null
        repo: null
        type: string
        publishedAtMs: number
        summary: null
        content: null
      }>
    }>()
    const oldStarted = Promise.withResolvers<void>()
    let request = 0
    const feedRefresh = createFeedRefresh({
      database,
      now: () => now,
      getActivity: async () => {
        request += 1
        if (request === 1) {
          oldStarted.resolve()
          return oldResponse.promise
        }
        return {
          githubId: '1',
          items: [
            {
              id: 'new-claim-item',
              title: 'new claim',
              link: null,
              repo: null,
              type: 'push',
              publishedAtMs: now.getTime(),
              summary: null,
              content: null,
            },
          ],
        }
      },
    })

    const staleRefresh = feedRefresh.refreshOne('viewer', 'alice')
    await oldStarted.promise
    now = new Date('2026-07-15T12:11:00.000Z')
    await feedRefresh.refreshOne('viewer', 'alice')
    oldResponse.resolve({
      githubId: '1',
      items: [
        {
          id: 'stale-claim-item',
          title: 'stale claim',
          link: null,
          repo: null,
          type: 'push',
          publishedAtMs: now.getTime(),
          summary: null,
          content: null,
        },
      ],
    })
    await assert.rejects(staleRefresh, /superseded/)

    assert.equal(
      (await createLocalFeedSync({ database }).getManifest('viewer')).activity.headSeq,
      '1',
    )
    const page = await createVisibleFeed(database).list({ userId: 'viewer' })
    assert.deepEqual(
      page.items.map(item => item.id),
      ['new-claim-item'],
    )
  })
})
