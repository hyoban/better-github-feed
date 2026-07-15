import type { RefreshProgressEvent } from '@better-github-feed/contract'
import { useCallback, useState } from 'react'
import { toast } from 'sonner'

import { client, orpc, queryClient } from '@/utils/orpc'

export function useRefreshAllUsers() {
  const [isRefreshing, setIsRefreshing] = useState(false)

  const refreshAllUsers = useCallback(async () => {
    if (isRefreshing) return

    setIsRefreshing(true)
    const toastId = toast.loading('Refreshing...')

    let completed = 0
    let total = 0
    let skipped = 0
    let errors: { login: string; message: string }[] = []

    try {
      const iterator = (await client.feed.refresh({})) as AsyncIterable<RefreshProgressEvent>

      for await (const event of iterator) {
        switch (event.type) {
          case 'start':
            total = event.total
            skipped = event.skipped
            toast.loading(`Refreshing ${skipped}/${total}`, { id: toastId })
            break
          case 'success':
            completed += 1
            toast.loading(`Refreshing ${completed + skipped}/${total}`, { id: toastId })
            break
          case 'error':
            completed += 1
            errors.push({ login: event.login, message: event.message })
            toast.loading(`Refreshing ${completed + skipped}/${total}`, { id: toastId })
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
        const skippedMessage = skipped > 0 ? `; skipped ${skipped} recent or active refreshes` : ''
        toast.error(`Failed to refresh: ${failedLogins}${skippedMessage}`, { id: toastId })
      } else if (total === 0) {
        toast.info('No feeds to refresh', { id: toastId })
      } else if (skipped === total) {
        toast.info(`Skipped ${skipped} recent or active refreshes`, { id: toastId })
      } else {
        const skippedMessage = skipped > 0 ? `, skipped ${skipped} recent or active refreshes` : ''
        toast.success(`Refreshed ${total - skipped} feeds${skippedMessage}`, { id: toastId })
      }
    } catch (error) {
      const refreshableTotal = total - skipped
      const failedCount = refreshableTotal - completed + errors.length
      const succeededCount = completed - errors.length

      queryClient.invalidateQueries({ queryKey: orpc.feed.list.key() })
      queryClient.invalidateQueries({ queryKey: orpc.subscription.list.queryKey() })

      if (completed > 0) {
        const skippedMessage = skipped > 0 ? `, skipped ${skipped} recent or active refreshes` : ''
        toast.warning(
          `Refreshed ${succeededCount}/${refreshableTotal} feeds (${failedCount} failed)${skippedMessage}`,
          { id: toastId },
        )
      } else {
        toast.error(error instanceof Error ? error.message : 'Failed to refresh feeds', {
          id: toastId,
        })
      }
    } finally {
      setIsRefreshing(false)
    }
  }, [isRefreshing])

  return {
    isRefreshing,
    refreshAllUsers,
  }
}
