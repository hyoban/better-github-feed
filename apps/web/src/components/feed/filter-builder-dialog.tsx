import type { FilterGroup } from '@better-github-feed/shared'
import {
  emptyFilterGroup,
  feedItemFilterSchema,
  filterFnList,
} from '@better-github-feed/shared'
import { FilterBuilder, FilterSphereProvider, useFilterSphere } from '@fn-sphere/filter'
import { useState } from 'react'
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
import { prepareFilterPayload, useCreateFilter, useUpdateFilter } from '@/hooks/use-filters'
import { filterTheme } from '@/lib/filter-theme'

type FilterBuilderDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  editingFilter?: {
    id: string
    name: string
    filterRule: FilterGroup
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
  const [filterRule, setFilterRule] = useState<FilterGroup>(
    editingFilter?.filterRule ?? emptyFilterGroup,
  )

  const createFilter = useCreateFilter()
  const updateFilter = useUpdateFilter()

  const isEditing = !!editingFilter
  const isPending = createFilter.isPending || updateFilter.isPending

  const handleSave = async () => {
    if (!name.trim()) {
      toast.error('Please enter a filter name')
      return
    }

    if (filterRule.conditions.length === 0) {
      toast.error('Please add at least one filter rule')
      return
    }

    try {
      const payload = prepareFilterPayload(name.trim(), filterRule)

      if (isEditing) {
        await updateFilter.mutateAsync({
          id: editingFilter.id,
          ...payload,
        })
        toast.success('Filter updated')
      }
      else {
        await createFilter.mutateAsync(payload)
        toast.success('Filter created')
      }

      onOpenChange(false)
    }
    catch {
      toast.error(isEditing ? 'Failed to update filter' : 'Failed to create filter')
    }
  }

  // Reset state when dialog opens with new/different filter
  const handleOpenChange = (newOpen: boolean) => {
    if (newOpen) {
      setName(editingFilter?.name ?? '')
      setFilterRule(editingFilter?.filterRule ?? emptyFilterGroup)
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
          defaultRule={editingFilter?.filterRule ?? emptyFilterGroup}
          onFilterChange={setFilterRule}
        />

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isPending}>
            {isPending ? 'Saving...' : isEditing ? 'Update' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
