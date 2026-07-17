import assert from 'node:assert/strict'

import { it } from 'vite-plus/test'

import { initializeGithubFollowing } from './initial-following.ts'

it('refreshes uninitialized GitHub Activity after the first Following Sync', async () => {
  const calls: string[] = []

  const result = await initializeGithubFollowing('viewer', {
    syncFollowing: async userId => {
      calls.push(`following:${userId}`)
      return { total: 2, added: 2, removed: 0 }
    },
    refreshUninitializedFollowing: async userId => {
      calls.push(`activity:${userId}`)
      return { attempted: 2, succeeded: 2, failed: 0 }
    },
  })

  assert.deepEqual(calls, ['following:viewer', 'activity:viewer'])
  assert.deepEqual(result, { total: 2, added: 2, removed: 0 })
})
