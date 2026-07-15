import { useQuery } from '@tanstack/react-query'

import { orpc } from '@/utils/orpc'

export function useSubscriptionList(userId: string | undefined) {
  const options = orpc.subscription.list.queryOptions()
  const enabled = !!userId
  const query = useQuery({
    ...options,
    queryKey: [...options.queryKey, { userId }],
    enabled,
  })

  return {
    follows: enabled ? (query.data ?? []) : [],
    isLoading: enabled && query.isLoading,
    isSuccess: enabled && query.isSuccess,
  }
}
