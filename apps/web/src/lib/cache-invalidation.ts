import { toast } from 'sonner'

export type CacheInvalidationResult = {
  cacheStatus: 'fresh' | 'stale'
}

export function warnIfCacheInvalidationFailed(result: CacheInvalidationResult, message: string) {
  if (result.cacheStatus === 'stale') {
    toast.warning(message)
  }
}
