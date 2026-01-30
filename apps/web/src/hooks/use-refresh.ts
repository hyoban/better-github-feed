import { useCallback, useState } from 'react'
import { toast } from 'sonner'

import { client, orpc, queryClient } from '@/utils/orpc'

export function useRefresh() {
  const [isRefreshing, setIsRefreshing] = useState(false)

  const refreshActivity = useCallback(async () => {
    if (isRefreshing)
      return

    setIsRefreshing(true)
    const toastId = toast.loading('Refreshing...')
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 10000)

    let completed = 0
    let total = 0
    let errors: { login: string, message: string }[] = []

    try {
      const iterator = await client.feed.refresh({}, { signal: controller.signal })

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
      const isTimeout = controller.signal.aborted
      const failedCount = total - completed + errors.length

      queryClient.invalidateQueries({ queryKey: orpc.feed.list.key() })
      queryClient.invalidateQueries({ queryKey: orpc.subscription.list.queryKey() })

      if (completed > 0) {
        const message = isTimeout
          ? `Refreshed ${completed}/${total} feeds (timed out)`
          : `Refreshed ${completed}/${total} feeds (${failedCount} failed)`
        toast.warning(message, { id: toastId })
      }
      else {
        toast.error(error instanceof Error ? error.message : 'Failed to refresh feeds', {
          id: toastId,
        })
      }
    }
    finally {
      clearTimeout(timeoutId)
      setIsRefreshing(false)
    }
  }, [isRefreshing])

  return {
    isRefreshing,
    refreshActivity,
  }
}
