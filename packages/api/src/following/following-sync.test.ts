import assert from 'node:assert/strict'

import { account, user } from '@better-github-feed/db/schema/auth'
import { afterEach, describe, it } from 'vite-plus/test'

import { createTestDatabase } from '../test/database.ts'
import { createFollowingSync } from './following-sync.ts'

const disposers: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposers.splice(0).map(dispose => dispose()))
})

describe('Following Sync', () => {
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
      accountId: 'viewer-github',
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
  })
})
