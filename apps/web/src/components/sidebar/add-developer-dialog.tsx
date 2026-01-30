import { useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { useAddSubscription, useExportOpml, useImportOpml } from '@/hooks/use-subscription-actions'
import { useSubscriptionList } from '@/hooks/use-subscription-list'
import { authClient } from '@/lib/auth-client'

export function AddDeveloperDialog() {
  const { data: session } = authClient.useSession()
  const { follows } = useSubscriptionList(!!session)
  const { addUser, isPending: isAddPending } = useAddSubscription()
  const { importOpml, isPending: isImportPending } = useImportOpml()
  const { exportOpml } = useExportOpml()

  const hasFollows = follows.length > 0

  const [loginInput, setLoginInput] = useState('')
  const [opmlFile, setOpmlFile] = useState<File | null>(null)
  const [opmlInputKey, setOpmlInputKey] = useState(0)

  const handleAddSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    if (!loginInput.trim()) {
      return
    }
    addUser(loginInput)
    setLoginInput('')
  }

  const handleImportSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!opmlFile || isImportPending) {
      return
    }
    const text = await opmlFile.text()
    importOpml(text)
    setOpmlFile(null)
    setOpmlInputKey(prev => prev + 1)
  }

  return (
    <Dialog>
      <DialogTrigger render={<Button variant="default" size="sm" />}>Add Developer</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add</DialogTitle>
          <DialogDescription>Add a GitHub user by username or import from OPML.</DialogDescription>
        </DialogHeader>
        <form className="flex gap-2" onSubmit={handleAddSubmit}>
          <Input
            value={loginInput}
            onChange={event => setLoginInput(event.target.value)}
            placeholder="username…"
            aria-label="GitHub username"
            autoComplete="username"
            className="flex-1"
          />
          <Button type="submit" disabled={isAddPending || !loginInput.trim()}>
            {isAddPending ? 'Adding...' : 'Add'}
          </Button>
        </form>
        <Separator />
        <form className="space-y-4" onSubmit={handleImportSubmit}>
          <Input
            key={opmlInputKey}
            type="file"
            accept=".opml,text/xml,application/xml"
            disabled={isImportPending}
            aria-label="Select OPML file to import"
            onChange={(event) => {
              const file = event.target.files?.[0] ?? null
              setOpmlFile(file)
            }}
          />
          <p className="text-xs text-muted-foreground">
            {opmlFile?.name ?? 'Import from OPML (only github.com/xxx.atom links)'}
          </p>
          <div className="flex gap-2">
            <Button
              type="submit"
              variant="outline"
              className="flex-1"
              disabled={!opmlFile || isImportPending}
            >
              {isImportPending ? 'Importing...' : 'Import'}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="flex-1"
              disabled={!hasFollows}
              onClick={exportOpml}
            >
              Export
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
