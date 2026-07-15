import type { RefreshProgressEvent } from '@better-github-feed/contract'
import { useCallback, useState } from 'react'
import { toast } from 'sonner'

import { client, orpc, queryClient } from '@/utils/orpc'

export function useRefreshAllUsers() {
  const [isRefreshing, setIsRefreshing] = useState(false)

  const refreshAllUsers = useCallback(async () => {
    if (isRefreshing)
      return

    setIsRefreshing(true)
    const toastId = toast.loading('Refreshing...')

    let completed = 0
    let total = 0
    let errors: { login: string, message: string }[] = []

    try {
      const iterator = await client.feed.refresh({}) as AsyncIterable<RefreshProgressEvent>

      for await (const event of iterator) {
        switch (event.type) {
          case 'start':
            total = event.total
            toast.loading(`Refreshing 0/${total}`, { id: toastId })
            break
          case 'success':
          case 'error':
            completed += 1
            toast.loading(`Refreshing ${completed}/${total}`, { id: toastId })
            break
          case 'done':
            errors = event.errors
            break
        }
      }

      queryClient.invalidateQueries({ queryKey: orpc.feed.list.key() })
      queryClient.invalidateQueries({ queryKey: orpc.subscription.list.queryKey() })

      if (errors.length > 0) {
        const failedLogins = errors.map(error => `@${error.login}`).join(', ')
        toast.error(`Failed to refresh: ${failedLogins}`, { id: toastId })
      }
      else {
        toast.success(`Refreshed ${total} feeds`, { id: toastId })
      }
    }
    catch (error) {
      const failedCount = total - completed + errors.length

      queryClient.invalidateQueries({ queryKey: orpc.feed.list.key() })
      queryClient.invalidateQueries({ queryKey: orpc.subscription.list.queryKey() })

      if (completed > 0) {
        toast.warning(`Refreshed ${completed}/${total} feeds (${failedCount} failed)`, {
          id: toastId,
        })
      }
      else {
        toast.error(error instanceof Error ? error.message : 'Failed to refresh feeds', {
          id: toastId,
        })
      }
    }
    finally {
      setIsRefreshing(false)
    }
  }, [isRefreshing])

  return {
    isRefreshing,
    refreshAllUsers,
  }
}
