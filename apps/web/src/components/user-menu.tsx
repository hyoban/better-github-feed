import { ChevronDownIcon, RefreshCwIcon } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

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
import { useLocalFeedInstance, useLocalSyncStatus } from '@/hooks/use-local-feed'
import { runDevBackendSync, triggerDevBackendSync } from '@/lib/dev-backend-sync'

import { Button } from './ui/button'

export default function UserMenu() {
  const account = useLocalFirstAccount()
  const feed = useLocalFeedInstance()
  const syncStatus = useLocalSyncStatus()
  const [signOutOpen, setSignOutOpen] = useState(false)
  const [working, setWorking] = useState<'delete' | 'retain' | null>(null)
  const [isDevSyncing, setIsDevSyncing] = useState(false)

  const pendingOperations =
    syncStatus.kind === 'ready' ? syncStatus.value.pendingUserOperations : null

  async function handleSignOut(localData: 'delete' | 'retain-locked') {
    setWorking(localData === 'delete' ? 'delete' : 'retain')
    await account.signOut(localData)
  }

  async function handleDevSync() {
    if (isDevSyncing) return
    setIsDevSyncing(true)
    const toastId = toast.loading('Syncing backend…')
    try {
      await runDevBackendSync({
        triggerBackendSync: triggerDevBackendSync,
        requestLocalSync: () => feed.requestSync(),
      })
      toast.success('Backend sync completed', { id: toastId })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Backend sync failed', { id: toastId })
    } finally {
      setIsDevSyncing(false)
    }
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
            {import.meta.env.DEV ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Development</DropdownMenuLabel>
                <DropdownMenuItem disabled={isDevSyncing} onClick={() => void handleDevSync()}>
                  <RefreshCwIcon className={isDevSyncing ? 'animate-spin' : undefined} />
                  {isDevSyncing ? 'Syncing backend…' : 'Sync backend now'}
                </DropdownMenuItem>
              </>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => setSignOutOpen(true)}>
              Sign Out
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>

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
              Keep Local Data
            </Button>
            <AlertDialogAction
              variant="destructive"
              disabled={working !== null || pendingOperations === null}
              onClick={() => void handleSignOut('delete')}
            >
              Delete & Sign Out
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
