import { useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'

import { feedMutations } from '@/utils/orpc'

export function useSyncFollowing() {
  const mutation = useMutation({
    mutationFn: () => feedMutations.syncFollowing(),
    onSuccess: result => {
      const data = result.data
      toast.success(
        `GitHub following synced: ${data.total} total, ${data.added} added, ${data.removed} removed`,
      )
      if (result.cacheStatus === 'stale') {
        toast.warning('Following synced, but cached data could not be refreshed')
      }
    },
    onError: error => {
      toast.error(error.message)
    },
  })

  return {
    syncFollowing: () => mutation.mutate(),
    isPending: mutation.isPending,
  }
}

export function useRefreshFeed() {
  const refreshSingleFeed = (login: string) => {
    toast.promise(feedMutations.refreshOne(login), {
      loading: `Refreshing @${login}...`,
      success: result => {
        const message = result.data.skipped
          ? `Skipped @${login}: refreshed recently or already refreshing`
          : `Refreshed @${login}: ${result.data.itemCount} items`
        return result.cacheStatus === 'stale' ? `${message}; cached data may be stale` : message
      },
      error: err => (err instanceof Error ? err.message : 'Failed to refresh'),
    })
  }

  return { refreshSingleFeed }
}
