import { countNumberOfRules } from '@fn-sphere/filter'
import { PencilIcon, PlusIcon, TrashIcon } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

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
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useUserFilterActions, useUserFilters } from '@/hooks/use-local-feed'
import type { LocalUserFilter } from '@/local-feed'

import { Badge } from '../ui/badge'
import { FilterBuilderDialog } from './filter-builder-dialog'

function FilterRuleItem({
  filter,
  onEdit,
  onDelete,
}: {
  filter: LocalUserFilter
  onEdit: () => void
  onDelete: () => void
}) {
  const ruleCount = filter.isValid ? countNumberOfRules(filter.rule) : 0

  return (
    <div className="flex items-center justify-between gap-2 rounded-md border bg-card p-3">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="truncate font-medium">{filter.name}</span>
        {filter.isValid ? (
          <span className="text-muted-foreground">
            {ruleCount} {ruleCount === 1 ? 'rule' : 'rules'}
          </span>
        ) : (
          <Badge variant="destructive" title="This legacy rule is ignored until it can be repaired">
            Invalid rule, ignored
          </Badge>
        )}
        {filter.sync === 'pending' && <Badge variant="secondary">Pending sync</Badge>}
        {filter.sync === 'conflict-copy' && <Badge variant="outline">Conflict copy</Badge>}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button variant="ghost" size="icon-sm" onClick={onEdit} disabled={!filter.isValid}>
          <PencilIcon className="size-4" />
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={onDelete}>
          <TrashIcon className="size-4" />
        </Button>
      </div>
    </div>
  )
}

function FilterRulesList() {
  const snapshot = useUserFilters()
  const filters = snapshot.kind === 'ready' ? snapshot.value : []
  const filterActions = useUserFilterActions()

  const [editingFilter, setEditingFilter] = useState<Extract<
    LocalUserFilter,
    { isValid: true }
  > | null>(null)
  const [deletingFilter, setDeletingFilter] = useState<LocalUserFilter | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [isCreateOpen, setIsCreateOpen] = useState(false)

  const handleDelete = async () => {
    if (!deletingFilter) return

    setIsDeleting(true)
    try {
      await filterActions.delete(deletingFilter.id)
      toast.success('Filter deleted locally')
      setDeletingFilter(null)
    } catch {
      toast.error('Failed to delete local filter')
    } finally {
      setIsDeleting(false)
    }
  }

  return (
    <>
      <div className="flex flex-col gap-3">
        <Button variant="outline" size="sm" onClick={() => setIsCreateOpen(true)}>
          <PlusIcon className="mr-1 size-4" />
          Add Filter
        </Button>

        <span className="font-medium">Your Filters</span>

        {snapshot.kind === 'opening-local' ? null : snapshot.kind === 'failed' ? (
          <div className="text-destructive">Local filters could not be read.</div>
        ) : filters.length > 0 ? (
          <ScrollArea className="max-h-75">
            <div className="flex flex-col gap-2">
              {filters.map(filter => (
                <FilterRuleItem
                  key={filter.id}
                  filter={filter}
                  onEdit={() => filter.isValid && setEditingFilter(filter)}
                  onDelete={() => setDeletingFilter(filter)}
                />
              ))}
            </div>
          </ScrollArea>
        ) : (
          <div className="rounded-md border bg-muted/30 py-4 text-center text-muted-foreground">
            No custom filters yet. Add a filter to hide specific feed items.
          </div>
        )}
      </div>

      {/* Create Filter Dialog */}
      <FilterBuilderDialog
        open={isCreateOpen}
        onOpenChange={setIsCreateOpen}
        editingFilter={null}
      />

      {/* Edit Filter Dialog */}
      <FilterBuilderDialog
        key={editingFilter?.id}
        open={!!editingFilter}
        onOpenChange={open => !open && setEditingFilter(null)}
        editingFilter={editingFilter}
      />

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={!!deletingFilter} onOpenChange={open => !open && setDeletingFilter(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Filter</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{deletingFilter?.name}
              "? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} disabled={isDeleting}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

export function FilterManagementDialog() {
  const snapshot = useUserFilters()
  const filterCount = snapshot.kind === 'ready' ? snapshot.value.length : 0

  return (
    <Dialog>
      <DialogTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1 rounded-full font-normal text-muted-foreground hover:text-foreground"
          >
            Filters
            {filterCount > 0 && (
              <Badge variant="secondary" className="font-normal opacity-60">
                {filterCount}
              </Badge>
            )}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Manage Filters</DialogTitle>
          <DialogDescription>
            Create and manage filters to hide feed items that match certain criteria. These filters
            are always applied to your feed.
          </DialogDescription>
        </DialogHeader>
        <FilterRulesList />
      </DialogContent>
    </Dialog>
  )
}
