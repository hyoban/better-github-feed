import { useQueryClient } from '@tanstack/react-query'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { authClient } from '@/lib/auth-client'
import { clearPersistedCache } from '@/utils/orpc'

import { Button } from './ui/button'
import { Skeleton } from './ui/skeleton'

export default function UserMenu() {
  const { data: session, isPending } = authClient.useSession()
  const qc = useQueryClient()

  const handleSignOut = () => {
    qc.clear()
    clearPersistedCache()
    authClient.signOut()
  }

  if (isPending) {
    return <Skeleton className="h-8 w-full" />
  }

  if (!session) {
    return (
      <Button
        variant="outline"
        size="sm"
        className="w-full"
        onClick={() => {
          authClient.signIn.social({
            provider: 'github',
            callbackURL: window.location.href,
          })
        }}
      >
        Sign In
      </Button>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" size="sm" aria-label="User menu" />}>
        {session.user.name}
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuGroup>
          <DropdownMenuLabel>My Account</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem>{session.user.email}</DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onClick={handleSignOut}>
            Sign Out
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
