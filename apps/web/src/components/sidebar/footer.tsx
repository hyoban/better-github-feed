import UserMenu from '@/components/user-menu'
import { Button } from '@/components/ui/button'

import { SyncStatusIndicator } from './sync-status'

export function SidebarFooter() {
  return (
    <div className="mobile-safe-footer flex items-center gap-0.5 border-t p-1.5">
      <Button
        variant="ghost"
        size="icon-sm"
        render={
          <a
            href="https://github.com/hyoban/better-github-feed"
            target="_blank"
            rel="noreferrer"
            aria-label="Open project on GitHub"
            title="Open project on GitHub"
          />
        }
      >
        <ProductIcon />
      </Button>
      <SyncStatusIndicator compact />
      <UserMenu />
    </div>
  )
}

function ProductIcon() {
  return <img src="/icon.svg" alt="" className="size-5" aria-hidden="true" />
}
