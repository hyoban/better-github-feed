import type { FilterTheme } from '@fn-sphere/filter'
import { useFilterGroup, useRootRule } from '@fn-sphere/filter'
import { PlusIcon, TrashIcon } from 'lucide-react'
import type { ComponentProps } from 'react'
import { useCallback } from 'react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export function FilterThemeGroupContainer({
  rule,
  children,
  ...props
}: ComponentProps<FilterTheme['templates']['FilterGroupContainer']>) {
  const { getLocaleText } = useRootRule()
  const {
    ruleState: { isRoot, depth },
    toggleGroupOp,
    appendChildRule,
    appendChildGroup,
    removeGroup,
  } = useFilterGroup(rule)

  const text = rule.op === 'or' ? getLocaleText('operatorOr') : getLocaleText('operatorAnd')

  const handleToggleGroupOp = useCallback(() => {
    toggleGroupOp()
  }, [toggleGroupOp])

  const handleAddCondition = useCallback(() => {
    appendChildRule()
  }, [appendChildRule])

  const handleAddGroup = useCallback(() => {
    appendChildGroup()
  }, [appendChildGroup])

  const handleDeleteGroup = useCallback(() => {
    removeGroup()
  }, [removeGroup])

  return (
    <div
      className={cn(
        'flex w-full min-w-0 flex-col items-stretch gap-3 rounded-md border bg-muted/30 p-3',
        !isRoot && 'mt-3',
      )}
      {...props}
    >
      <div className="flex w-full flex-wrap gap-2">
        <Button variant="default" size="sm" onClick={handleToggleGroupOp}>
          {text}
        </Button>
        <Button variant="outline" size="sm" onClick={handleAddCondition}>
          <PlusIcon className="mr-1 size-4" />
          {getLocaleText('addRule')}
        </Button>
        {depth < 3 && (
          <Button variant="outline" size="sm" onClick={handleAddGroup}>
            <PlusIcon className="mr-1 size-4" />
            {getLocaleText('addGroup')}
          </Button>
        )}
        {!isRoot && (
          <Button variant="ghost" size="sm" onClick={handleDeleteGroup}>
            <TrashIcon className="mr-1 size-4" />
            {getLocaleText('deleteGroup')}
          </Button>
        )}
      </div>
      {children}
    </div>
  )
}
