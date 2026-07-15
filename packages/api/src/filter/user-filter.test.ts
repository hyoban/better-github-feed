import assert from 'node:assert/strict'

import {
  feedItem,
  githubUser,
  subscription,
  userFilter,
} from '@better-github-feed/db/schema/github'
import type { FilterGroup } from '@better-github-feed/shared'
import { afterEach, describe, it } from 'vite-plus/test'

import { createTestDatabase } from '../test/database.ts'
import { createVisibleFeed } from '../feed/visible-feed.ts'
import { createUserFilters } from './user-filter.ts'

const disposers: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposers.splice(0).map(dispose => dispose()))
})

describe('User Filter', () => {
  it('accepts a validated rule value without a storage codec', async () => {
    const testDatabase = await createTestDatabase()
    disposers.push(testDatabase.dispose)
    const filters = createUserFilters(testDatabase.database)
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

    const created = await filters.create('viewer', { name: 'Hide stars', filterRule: hideStars })
    const listed = await filters.list('viewer')

    assert.equal(created.isValid, true)
    assert.deepEqual(listed[0]?.filterRule, hideStars)
  })

  it('marks an invalid rule while keeping the Visible Feed available', async () => {
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
      type: 'push',
      publishedAt: new Date('2026-07-15T12:00:00.000Z'),
    })
    await database.insert(userFilter).values({
      id: 'broken-filter',
      userId: 'viewer',
      name: 'Old rule',
      filterRule: '{"type":"Unknown"}',
    })

    const filters = await createUserFilters(database).list('viewer')
    const page = await createVisibleFeed(database).list({ userId: 'viewer' })

    assert.deepEqual(
      filters.map(filter => ({
        id: filter.id,
        isValid: filter.isValid,
        filterRule: filter.filterRule,
      })),
      [{ id: 'broken-filter', isValid: false, filterRule: null }],
    )
    assert.deepEqual(
      page.items.map(item => item.id),
      ['alice-push'],
    )
  })

  it('marks unsupported nested rules as invalid', async () => {
    const testDatabase = await createTestDatabase()
    disposers.push(testDatabase.dispose)
    const { database } = testDatabase
    await database.insert(userFilter).values({
      id: 'unsupported-filter',
      userId: 'viewer',
      name: 'Unsupported rule',
      filterRule: JSON.stringify({
        id: 'root',
        type: 'FilterGroup',
        op: 'and',
        conditions: [
          {
            id: 'unknown-operation',
            type: 'Filter',
            path: ['title'],
            name: 'unknownOperation',
            args: ['value'],
          },
        ],
      }),
    })

    const filters = await createUserFilters(database).list('viewer')

    assert.equal(filters[0]?.isValid, false)
  })
})
