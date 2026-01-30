import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'

type RemoveUserDialogProps = {
  username: string
  disabled: boolean
  onConfirm: () => void
}

export function RemoveUserDialog({ username, disabled, onConfirm }: RemoveUserDialogProps) {
  return (
    <AlertDialog>
      <AlertDialogTrigger
        disabled={disabled}
        className="relative flex w-full cursor-default items-center rounded-sm px-2 py-1.5 text-sm text-destructive transition-colors outline-none select-none hover:bg-accent hover:text-destructive data-disabled:pointer-events-none data-disabled:opacity-50"
      >
        Remove
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Remove @
            {username}
            ?
          </AlertDialogTitle>
          <AlertDialogDescription>
            This will remove @
            {username}
            {' '}
            from your following list and their activity will no longer
            appear in your feed.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={disabled} onClick={onConfirm}>
            Remove
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
