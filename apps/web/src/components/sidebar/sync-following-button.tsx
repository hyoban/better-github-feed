import { RefreshCwIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useSyncFollowing } from '@/hooks/use-subscription-actions'
import { authClient } from '@/lib/auth-client'

export function SyncFollowingButton() {
  const { data: session } = authClient.useSession()
  const { syncFollowing, isPending } = useSyncFollowing()

  if (!session) {
    return null
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={isPending}
      onClick={syncFollowing}
    >
      <RefreshCwIcon className={isPending ? 'animate-spin' : undefined} />
      {isPending ? 'Syncing...' : 'Sync GitHub'}
    </Button>
  )
}
