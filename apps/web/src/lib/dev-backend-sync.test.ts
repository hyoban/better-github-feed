import { describe, expect, it, vi } from 'vite-plus/test'

import type { RefreshProgressEvent } from '@better-github-feed/contract'

import { runDevBackendSync } from './dev-backend-sync'

async function* events(items: readonly RefreshProgressEvent[]) {
  for (const item of items) yield item
}

describe('runDevBackendSync', () => {
  it('syncs following before activity and then requests a local pull', async () => {
    const calls: string[] = []
    const requestLocalSync = vi.fn(() => calls.push('local'))

    const result = await runDevBackendSync({
      syncFollowing: async () => {
        calls.push('following')
      },
      refreshFollowing: async () => {
        calls.push('activity')
        return events([
          { type: 'start', total: 3, skipped: 1 },
          { type: 'success', login: 'alice', index: 0, itemCount: 2 },
          { type: 'error', login: 'bob', index: 1, message: 'failed' },
          { type: 'done', errors: [{ login: 'bob', message: 'failed' }] },
        ])
      },
      requestLocalSync,
    })

    expect(calls).toEqual(['following', 'activity', 'local'])
    expect(result).toEqual({ total: 3, skipped: 1, refreshed: 1, failed: 1 })
    expect(requestLocalSync).toHaveBeenCalledOnce()
  })

  it('still requests a local pull when the backend sync fails', async () => {
    const requestLocalSync = vi.fn()

    await expect(
      runDevBackendSync({
        syncFollowing: async () => {
          throw new Error('backend unavailable')
        },
        refreshFollowing: async () => events([]),
        requestLocalSync,
      }),
    ).rejects.toThrow('backend unavailable')

    expect(requestLocalSync).toHaveBeenCalledOnce()
  })
})
