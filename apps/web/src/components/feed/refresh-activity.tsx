import { RotateCwIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useRefresh } from '@/hooks/use-refresh'

export function RefreshActivity() {
  const { isRefreshing, refreshActivity } = useRefresh()
  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      disabled={isRefreshing}
      onClick={refreshActivity}
      aria-label="Refresh activity feed"
    >
      <RotateCwIcon className={isRefreshing ? 'animate-spin' : ''} />
    </Button>
  )
}
