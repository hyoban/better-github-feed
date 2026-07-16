import type { RefreshProgressEvent } from '@better-github-feed/contract'

type DevBackendSyncDependencies = {
  syncFollowing: () => Promise<unknown>
  refreshFollowing: () => Promise<AsyncIterable<RefreshProgressEvent>>
  requestLocalSync: () => void
}

export type DevBackendSyncResult = {
  total: number
  skipped: number
  refreshed: number
  failed: number
}

export async function runDevBackendSync({
  syncFollowing,
  refreshFollowing,
  requestLocalSync,
}: DevBackendSyncDependencies): Promise<DevBackendSyncResult> {
  let total = 0
  let skipped = 0
  let refreshed = 0
  let failed = 0

  try {
    await syncFollowing()
    const events = await refreshFollowing()
    for await (const event of events) {
      switch (event.type) {
        case 'start':
          total = event.total
          skipped = event.skipped
          break
        case 'success':
          refreshed += 1
          break
        case 'error':
          failed += 1
          break
        case 'done':
          failed = event.errors.length
          break
      }
    }
    return { total, skipped, refreshed, failed }
  } finally {
    requestLocalSync()
  }
}
