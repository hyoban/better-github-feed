import { MenuIcon } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet'
import UserMenu from '@/components/user-menu'
import { authClient } from '@/lib/auth-client'

import { AddDeveloperDialog } from '../sidebar/add-developer-dialog'
import { FollowList } from '../sidebar/follow-list'
import { SortToggle } from '../sidebar/sort-toggle'

const LG_BREAKPOINT = 1024

export function MobileSidebar() {
  const { data: session } = authClient.useSession()
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const mediaQuery = window.matchMedia(`(min-width: ${LG_BREAKPOINT}px)`)
    const handleChange = (e: MediaQueryListEvent | MediaQueryList) => {
      if (e.matches) {
        setOpen(false)
      }
    }
    handleChange(mediaQuery)
    mediaQuery.addEventListener('change', handleChange)
    return () => mediaQuery.removeEventListener('change', handleChange)
  }, [])

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger render={<Button variant="ghost" size="icon" className="shrink-0" />}>
        <MenuIcon className="size-5" />
        <span className="sr-only">Toggle menu</span>
      </SheetTrigger>
      <SheetContent side="left" className="flex w-80 flex-col p-0" showCloseButton={false}>
        <div className="flex items-center border-b">
          <SortToggle />
        </div>
        <FollowList />
        <div className="flex justify-between gap-2 border-t p-2">
          <UserMenu />
          {session && <AddDeveloperDialog />}
        </div>
      </SheetContent>
    </Sheet>
  )
}
