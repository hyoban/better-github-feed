import { useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'

import { warnIfCacheInvalidationFailed } from '@/lib/cache-invalidation'
import { feedMutations } from '@/utils/orpc'

function onFollowingSynced(result: Awaited<ReturnType<typeof feedMutations.syncFollowing>>) {
  const data = result.data
  toast.success(
    `GitHub following synced: ${data.total} total, ${data.added} added, ${data.removed} removed`,
  )
  warnIfCacheInvalidationFailed(result, 'Following synced, but cached data could not be refreshed')
}

export function useFollowingSync() {
  const mutation = useMutation({
    mutationFn: () => feedMutations.syncFollowing(),
    onSuccess: onFollowingSynced,
    onError: error => {
      toast.error(error.message)
    },
  })

  return {
    syncFollowing: () => mutation.mutate(),
    isPending: mutation.isPending,
  }
}
