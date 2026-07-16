import type { FilterGroup } from '@better-github-feed/shared'
import { emptyFilterGroup, feedItemFilterSchema, filterFnList } from '@better-github-feed/shared'
import { FilterBuilder, FilterSphereProvider, useFilterSphere } from '@fn-sphere/filter'
import { useRef, useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useUserFilterActions } from '@/hooks/use-local-feed'
import { filterTheme } from '@/lib/filter-theme'

type FilterBuilderDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  editingFilter?: {
    id: string
    name: string
    rule: FilterGroup
  } | null
}

function FilterBuilderContent({
  name,
  setName,
  defaultRule,
  onFilterChange,
}: {
  name: string
  setName: (name: string) => void
  defaultRule: FilterGroup
  onFilterChange: (rule: FilterGroup) => void
}) {
  const { context } = useFilterSphere({
    schema: feedItemFilterSchema,
    defaultRule,
    filterFnList,
    onRuleChange: ({ filterRule }) => {
      onFilterChange(filterRule)
    },
  })

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="filter-name">Filter Name</Label>
        <Input
          id="filter-name"
          maxLength={100}
          placeholder="e.g., Hide bot repos"
          value={name}
          onChange={e => setName(e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label>Filter Rules</Label>
        <FilterSphereProvider context={context} theme={filterTheme}>
          <FilterBuilder />
        </FilterSphereProvider>
      </div>
    </div>
  )
}

export function FilterBuilderDialog({
  open,
  onOpenChange,
  editingFilter,
}: FilterBuilderDialogProps) {
  const [name, setName] = useState(editingFilter?.name ?? '')
  const filterRuleRef = useRef<FilterGroup>(editingFilter?.rule ?? emptyFilterGroup)

  const filterActions = useUserFilterActions()
  const [isPending, setIsPending] = useState(false)

  const isEditing = !!editingFilter

  const handleSave = async () => {
    const normalizedName = name.trim()
    if (!normalizedName) {
      toast.error('Please enter a filter name')
      return
    }
    if (normalizedName.length > 100) {
      toast.error('Filter names must be 100 characters or fewer')
      return
    }

    if (filterRuleRef.current.conditions.length === 0) {
      toast.error('Please add at least one filter rule')
      return
    }

    setIsPending(true)
    try {
      await filterActions.put({
        id: editingFilter?.id,
        name: normalizedName,
        rule: filterRuleRef.current,
      })
      toast.success(isEditing ? 'Filter updated locally' : 'Filter created locally')

      onOpenChange(false)
    } catch {
      toast.error(isEditing ? 'Failed to update local filter' : 'Failed to create local filter')
    } finally {
      setIsPending(false)
    }
  }

  // Reset state when dialog opens with new/different filter
  const handleOpenChange = (newOpen: boolean) => {
    if (newOpen) {
      setName(editingFilter?.name ?? '')
      filterRuleRef.current = editingFilter?.rule ?? emptyFilterGroup
    }
    onOpenChange(newOpen)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="min-w-xl">
        <DialogHeader>
          <DialogTitle>{isEditing ? 'Edit Filter' : 'Create Filter'}</DialogTitle>
          <DialogDescription>
            Create filter rules to hide feed items that match certain criteria. Items matching these
            rules will be hidden from your feed.
          </DialogDescription>
        </DialogHeader>

        <FilterBuilderContent
          name={name}
          setName={setName}
          defaultRule={editingFilter?.rule ?? emptyFilterGroup}
          onFilterChange={rule => {
            filterRuleRef.current = rule
          }}
        />

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isPending}>
            {isEditing ? 'Update' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
