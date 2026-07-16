import assert from 'node:assert/strict'

import {
  feedItem,
  githubUser,
  subscription,
  userFeedState,
  userFilter,
} from '@better-github-feed/db/schema/github'
import type { FilterGroup } from '@better-github-feed/shared'
import { afterEach, describe, it } from 'vite-plus/test'

import { serializeFilterGroup } from '../filter/drizzle-transform.ts'
import { createTestDatabase } from '../test/database.ts'
import { createVisibleFeed } from './visible-feed.ts'

const disposers: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposers.splice(0).map(dispose => dispose()))
})

describe('Visible Feed', () => {
  it('hides matches consistently from activity and counts', async () => {
    const testDatabase = await createTestDatabase()
    disposers.push(testDatabase.dispose)
    const { database } = testDatabase
    const now = new Date('2026-07-15T12:00:00.000Z')

    await database.insert(githubUser).values([
      { id: '1', login: 'alice' },
      { id: '2', login: 'bob' },
    ])
    await database.insert(subscription).values([
      { id: 'sub-alice', userId: 'viewer', githubUserLogin: 'alice' },
      { id: 'sub-bob', userId: 'viewer', githubUserLogin: 'bob' },
    ])
    await database.insert(feedItem).values([
      {
        id: 'alice-star',
        githubUserLogin: 'alice',
        title: 'starred a repository',
        type: 'star',
        publishedAt: new Date(now.getTime() - 1_000),
      },
      {
        id: 'alice-push',
        githubUserLogin: 'alice',
        title: 'pushed a commit',
        type: 'push',
        publishedAt: now,
      },
      {
        id: 'bob-star',
        githubUserLogin: 'bob',
        title: 'starred another repository',
        type: 'star',
        publishedAt: new Date(now.getTime() - 2_000),
      },
    ])

    const hideStars = {
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
    await database.insert(userFilter).values({
      id: 'filter-stars',
      userId: 'viewer',
      name: 'Hide stars',
      filterRule: serializeFilterGroup(hideStars),
    })

    const visibleFeed = createVisibleFeed(database)
    const page = await visibleFeed.list({ userId: 'viewer' })
    const follows = await visibleFeed.listFollowing('viewer')

    assert.deepEqual(
      page.items.map(item => item.id),
      ['alice-push'],
    )
    assert.deepEqual(page.types, ['push'])
    assert.deepEqual(page.typeCounts, { push: 1 })
    assert.deepEqual(
      follows.map(follow => ({ login: follow.githubUserLogin, itemCount: follow.itemCount })),
      [
        { login: 'alice', itemCount: 1 },
        { login: 'bob', itemCount: 0 },
      ],
    )
  })

  it('fails open for nullable fields that do not match a User Filter', async () => {
    const testDatabase = await createTestDatabase()
    disposers.push(testDatabase.dispose)
    const { database } = testDatabase

    await database.insert(githubUser).values({ id: '1', login: 'alice' })
    await database.insert(subscription).values({
      id: 'sub-alice',
      userId: 'viewer',
      githubUserLogin: 'alice',
    })
    await database.insert(feedItem).values({
      id: 'alice-push',
      githubUserLogin: 'alice',
      title: 'pushed a commit',
      repo: null,
      type: 'push',
      publishedAt: new Date('2026-07-15T12:00:00.000Z'),
    })
    await database.insert(userFilter).values({
      id: 'filter-repo',
      userId: 'viewer',
      name: 'Hide one repository',
      filterRule: serializeFilterGroup({
        id: 'hide-repo',
        type: 'FilterGroup',
        op: 'and',
        conditions: [
          {
            id: 'repo-is-example',
            type: 'Filter',
            path: ['repo'],
            name: 'equals',
            args: ['owner/example'],
          },
        ],
      } as FilterGroup),
    })

    const page = await createVisibleFeed(database).list({ userId: 'viewer' })

    assert.deepEqual(
      page.items.map(item => item.id),
      ['alice-push'],
    )
  })

  it('uses a stable cursor when activities share a publication time', async () => {
    const testDatabase = await createTestDatabase()
    disposers.push(testDatabase.dispose)
    const { database } = testDatabase
    const publishedAt = new Date('2026-07-15T12:00:00.000Z')

    await database.insert(githubUser).values({ id: '1', login: 'alice' })
    await database.insert(subscription).values({
      id: 'sub-alice',
      userId: 'viewer',
      githubUserLogin: 'alice',
    })
    await database.insert(feedItem).values([
      {
        id: 'activity-b',
        githubUserLogin: 'alice',
        title: 'second activity',
        type: 'push',
        publishedAt,
      },
      {
        id: 'activity-a',
        githubUserLogin: 'alice',
        title: 'first activity',
        type: 'push',
        publishedAt,
      },
    ])

    const visibleFeed = createVisibleFeed(database)
    const firstPage = await visibleFeed.list({ userId: 'viewer', limit: 1 })
    const secondPage = await visibleFeed.list({
      userId: 'viewer',
      limit: 1,
      cursor: firstPage.nextCursor ?? undefined,
    })

    assert.deepEqual(
      [...firstPage.items, ...secondPage.items].map(item => item.id),
      ['activity-b', 'activity-a'],
    )
  })

  it('clears one app user view without deleting shared GitHub Activity', async () => {
    const testDatabase = await createTestDatabase()
    disposers.push(testDatabase.dispose)
    const { database } = testDatabase

    await database.insert(githubUser).values({ id: '1', login: 'alice' })
    await database.insert(subscription).values([
      { id: 'viewer-alice', userId: 'viewer', githubUserLogin: 'alice' },
      { id: 'other-alice', userId: 'other', githubUserLogin: 'alice' },
    ])
    await database.insert(feedItem).values({
      id: 'alice-push',
      githubUserLogin: 'alice',
      title: 'pushed a commit',
      type: 'push',
      publishedAt: new Date('2026-07-15T12:00:00.000Z'),
    })

    const visibleFeed = createVisibleFeed(database)
    await visibleFeed.clear('viewer', new Date('2026-07-15T12:01:00.000Z'))

    assert.deepEqual((await visibleFeed.list({ userId: 'viewer' })).items, [])
    assert.deepEqual(
      (await visibleFeed.list({ userId: 'other' })).items.map(item => item.id),
      ['alice-push'],
    )
  })

  it('rebases concurrent legacy clear requests after CAS conflicts', async () => {
    const testDatabase = await createTestDatabase()
    disposers.push(testDatabase.dispose)
    const { database } = testDatabase
    const visibleFeed = createVisibleFeed(database)
    const clearTimes = Array.from(
      { length: 6 },
      (_, index) => new Date(Date.parse('2026-07-15T12:00:00.000Z') + index),
    )

    await Promise.all(clearTimes.map(clearedAt => visibleFeed.clear('viewer', clearedAt)))

    const states = await database.select().from(userFeedState)
    assert.equal(states[0]?.activityClearedAt.getTime(), clearTimes.at(-1)?.getTime())
  })
})
