import { describe, expect, it, vi } from 'vite-plus/test'

import { runDevBackendSync } from './dev-backend-sync'

describe('runDevBackendSync', () => {
  it('requests a local pull after the backend maintenance completes', async () => {
    const calls: string[] = []
    const requestLocalSync = vi.fn(() => calls.push('local'))

    await runDevBackendSync({
      triggerBackendSync: async () => {
        calls.push('backend')
      },
      requestLocalSync,
    })

    expect(calls).toEqual(['backend', 'local'])
    expect(requestLocalSync).toHaveBeenCalledOnce()
  })

  it('does not request a local pull when backend maintenance fails', async () => {
    const requestLocalSync = vi.fn()

    await expect(
      runDevBackendSync({
        triggerBackendSync: async () => {
          throw new Error('backend unavailable')
        },
        requestLocalSync,
      }),
    ).rejects.toThrow('backend unavailable')

    expect(requestLocalSync).not.toHaveBeenCalled()
  })
})
