import UserMenu from '@/components/user-menu'
import { Button } from '@/components/ui/button'

import { SyncStatusIndicator } from './sync-status'

export function SidebarFooter() {
  return (
    <div className="mobile-safe-footer flex items-center gap-0.5 border-t p-1.5">
      <SyncStatusIndicator compact />
      <UserMenu />
      <Button
        variant="ghost"
        size="sm"
        className="px-2 font-normal text-muted-foreground"
        render={
          <a
            href="https://github.com/hyoban/better-github-feed"
            target="_blank"
            rel="noreferrer"
            aria-label="Open project on GitHub"
          />
        }
      >
        GitHub
      </Button>
    </div>
  )
}
