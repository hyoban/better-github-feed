import { ChevronDownIcon } from 'lucide-react'
import { useState } from 'react'

import { useLocalFirstAccount } from '@/components/local-feed/local-first-account'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useFeedActions, useLocalSyncStatus } from '@/hooks/use-local-feed'

import { Button } from './ui/button'

export default function UserMenu() {
  const account = useLocalFirstAccount()
  const feedActions = useFeedActions()
  const syncStatus = useLocalSyncStatus()
  const [clearOpen, setClearOpen] = useState(false)
  const [signOutOpen, setSignOutOpen] = useState(false)
  const [working, setWorking] = useState<'clear' | 'delete' | 'retain' | null>(null)

  const pendingOperations =
    syncStatus.kind === 'ready' ? syncStatus.value.pendingUserOperations : null

  async function handleClearFeed() {
    setWorking('clear')
    try {
      await feedActions.clearFeed()
      setClearOpen(false)
    } finally {
      setWorking(null)
    }
  }

  async function handleSignOut(localData: 'delete' | 'retain-locked') {
    setWorking(localData === 'delete' ? 'delete' : 'retain')
    await account.signOut(localData)
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              className="min-w-0 flex-1 justify-between px-2"
              aria-label="User menu"
            />
          }
        >
          <span className="truncate">{account.sessionProfile?.name ?? 'Offline account'}</span>
          <ChevronDownIcon className="size-3.5 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuGroup>
            <DropdownMenuLabel>My Account</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled>
              {account.sessionProfile?.email ?? `GitHub ID ${account.ownerGithubId}`}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setClearOpen(true)}>Clear Feed</DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={() => setSignOutOpen(true)}>
              Sign Out
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={clearOpen} onOpenChange={setClearOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear Feed?</AlertDialogTitle>
            <AlertDialogDescription>
              This immediately hides all Activity currently known to this local account and queues
              the clear watermark for sync. Saved Activity is retained locally.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={working !== null}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={working !== null} onClick={() => void handleClearFeed()}>
              {working === 'clear' ? 'Clearing…' : 'Clear Feed'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={signOutOpen} onOpenChange={setSignOutOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sign out?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingOperations === null ? (
                'The local outbox is still being inspected. Wait a moment before signing out.'
              ) : pendingOperations > 0 ? (
                <>
                  <strong className="text-foreground">
                    {pendingOperations} unsynced local{' '}
                    {pendingOperations === 1 ? 'change' : 'changes'}
                    {' will be lost if you delete local data.'}
                  </strong>{' '}
                  You can keep the database locked instead and unlock it later by signing in with
                  the same numeric GitHub account ID.
                </>
              ) : (
                'Deleting is the default. You may explicitly keep this account database locked for a later sign-in.'
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={working !== null}>Cancel</AlertDialogCancel>
            <Button
              variant="outline"
              disabled={working !== null || pendingOperations === null}
              onClick={() => void handleSignOut('retain-locked')}
            >
              {working === 'retain' ? 'Locking…' : 'Keep Local Data'}
            </Button>
            <AlertDialogAction
              variant="destructive"
              disabled={working !== null || pendingOperations === null}
              onClick={() => void handleSignOut('delete')}
            >
              {working === 'delete' ? 'Deleting…' : 'Delete & Sign Out'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
