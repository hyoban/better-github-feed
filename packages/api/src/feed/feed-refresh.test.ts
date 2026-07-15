import assert from 'node:assert/strict'

import { githubUser, subscription } from '@better-github-feed/db/schema/github'
import { afterEach, describe, it } from 'vite-plus/test'

import { createTestDatabase } from '../test/database.ts'
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
})
