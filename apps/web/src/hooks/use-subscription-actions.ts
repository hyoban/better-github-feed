import { useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'

import { client, orpc, queryClient } from '@/utils/orpc'

export function useAddSubscription() {
  const mutation = useMutation(
    orpc.subscription.add.mutationOptions({
      onSuccess: (data) => {
        queryClient.invalidateQueries({ queryKey: orpc.subscription.list.queryKey() })
        queryClient.invalidateQueries({ queryKey: orpc.feed.list.key() })
        toast.success(`Added @${data.githubUserLogin}`)
      },
      onError: (error) => {
        toast.error(error.message)
      },
    }),
  )

  return {
    addUser: (login: string) => mutation.mutate({ login }),
    isPending: mutation.isPending,
  }
}

export function useRemoveSubscription() {
  const mutation = useMutation(
    orpc.subscription.remove.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: orpc.subscription.list.queryKey() })
        queryClient.invalidateQueries({ queryKey: orpc.feed.list.key() })
      },
      onError: (error) => {
        toast.error(error.message)
      },
    }),
  )

  return {
    removeUser: (id: string) => mutation.mutate({ id }),
    isPending: mutation.isPending,
  }
}

export function useImportOpml() {
  const mutation = useMutation(
    orpc.subscription.importOpml.mutationOptions({
      onSuccess: (data) => {
        queryClient.invalidateQueries({ queryKey: orpc.subscription.list.queryKey() })
        queryClient.invalidateQueries({ queryKey: orpc.feed.list.key() })
        const message
          = data.total === 0
            ? 'No GitHub Atom links found in the OPML file.'
            : `Imported ${data.added} of ${data.total} GitHub feeds.`
        toast.success(message)
      },
      onError: (error) => {
        toast.error(error.message)
      },
    }),
  )

  return {
    importOpml: (opml: string) => mutation.mutate({ opml }),
    isPending: mutation.isPending,
  }
}

export function useExportOpml() {
  const exportOpml = async () => {
    try {
      const { opml } = await client.subscription.exportOpml({})
      const blob = new Blob([opml], { type: 'application/xml' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'github-feeds.opml'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      toast.success('OPML exported successfully')
    }
    catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to export OPML')
    }
  }

  return { exportOpml }
}

export function useRefreshFeed() {
  const refreshSingleFeed = (login: string) => {
    toast.promise(
      client.feed.refreshOne({ login }).then((data) => {
        queryClient.invalidateQueries({ queryKey: orpc.feed.list.key() })
        queryClient.invalidateQueries({ queryKey: orpc.subscription.list.queryKey() })
        return data
      }),
      {
        loading: `Refreshing @${login}...`,
        success: data => `Refreshed @${login}: ${data.itemCount} items`,
        error: err => (err instanceof Error ? err.message : 'Failed to refresh'),
      },
    )
  }

  return { refreshSingleFeed }
}
