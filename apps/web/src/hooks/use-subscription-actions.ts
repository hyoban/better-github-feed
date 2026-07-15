import { useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'

import { client, orpc, queryClient } from '@/utils/orpc'

export function useSyncFollowing() {
  const mutation = useMutation(
    orpc.subscription.sync.mutationOptions({
      onSuccess: (data) => {
        void queryClient.invalidateQueries({ queryKey: orpc.subscription.list.queryKey() })
        void queryClient.invalidateQueries({ queryKey: orpc.feed.list.key() })
        toast.success(
          `GitHub following synced: ${data.total} total, ${data.added} added, ${data.removed} removed`,
        )
      },
      onError: (error) => {
        toast.error(error.message)
      },
    }),
  )

  return {
    syncFollowing: () => mutation.mutate({}),
    isPending: mutation.isPending,
  }
}

export function useRefreshFeed() {
  const refreshSingleFeed = (login: string) => {
    toast.promise(
      client.feed.refreshOne({ params: { login } }).then((data) => {
        queryClient.invalidateQueries({ queryKey: orpc.feed.list.key() })
        queryClient.invalidateQueries({ queryKey: orpc.subscription.list.queryKey() })
        return data
      }),
      {
        loading: `Refreshing @${login}...`,
        success: data => data.skipped
          ? `Skipped @${login}: refreshed recently or already refreshing`
          : `Refreshed @${login}: ${data.itemCount} items`,
        error: err => (err instanceof Error ? err.message : 'Failed to refresh'),
      },
    )
  }

  return { refreshSingleFeed }
}
