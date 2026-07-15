import { RefreshCwIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useSyncFollowing } from '@/hooks/use-subscription-actions'
import { authClient } from '@/lib/auth-client'

export function SyncFollowingButton() {
  const { data: session } = authClient.useSession()
  const { syncFollowing, isPending } = useSyncFollowing()

  if (!session) {
    return null
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            disabled={isPending}
            onClick={syncFollowing}
            aria-label={isPending ? 'Syncing GitHub following' : 'Sync GitHub following'}
          />
        }
      >
        <RefreshCwIcon className={isPending ? 'animate-spin' : undefined} />
      </TooltipTrigger>
      <TooltipContent>
        {isPending ? 'Syncing GitHub following' : 'Sync GitHub following'}
      </TooltipContent>
    </Tooltip>
  )
}
