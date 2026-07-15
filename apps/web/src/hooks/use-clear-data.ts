import { useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'

import { feedMutations } from '@/utils/orpc'

export function useClearData() {
  const clearActivityMutation = useMutation({
    mutationFn: () => feedMutations.clearFeed(),
    onSuccess: result => {
      toast.success('Activity data cleared')
      if (result.cacheStatus === 'stale') {
        toast.warning('Activity cleared, but cached data could not be refreshed')
      }
    },
    onError: error => {
      toast.error(error.message)
    },
  })

  return {
    clearActivity: () => clearActivityMutation.mutate(),
    isClearPending: clearActivityMutation.isPending,
  }
}
