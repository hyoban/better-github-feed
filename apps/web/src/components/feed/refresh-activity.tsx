import { RotateCwIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useRefreshAllUsers } from '@/hooks/use-refresh'
import { authClient } from '@/lib/auth-client'

export function RefreshAllUsersButton() {
  const { data: session } = authClient.useSession()
  const { isRefreshing, refreshAllUsers } = useRefreshAllUsers()

  if (!session) {
    return null
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={(
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            disabled={isRefreshing}
            onClick={refreshAllUsers}
            aria-label="Refresh all users"
          />
        )}
      >
        <RotateCwIcon className={isRefreshing ? 'animate-spin' : undefined} />
      </TooltipTrigger>
      <TooltipContent>Refresh all users</TooltipContent>
    </Tooltip>
  )
}
