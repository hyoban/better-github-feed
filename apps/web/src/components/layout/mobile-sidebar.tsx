import { MenuIcon } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet'

import { FollowList } from '../sidebar/follow-list'
import { SidebarFooter } from '../sidebar/footer'
import { SortToggle } from '../sidebar/sort-toggle'

const LG_BREAKPOINT = 1024

export function MobileSidebar() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const mediaQuery = window.matchMedia(`(min-width: ${LG_BREAKPOINT}px)`)
    const handleChange = (e: MediaQueryListEvent | MediaQueryList) => {
      if (e.matches && open) {
        setOpen(false)
      }
    }
    mediaQuery.addEventListener('change', handleChange)
    return () => mediaQuery.removeEventListener('change', handleChange)
  }, [open])

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
        <SidebarFooter />
      </SheetContent>
    </Sheet>
  )
}
