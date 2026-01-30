import type { FilterTheme } from '@fn-sphere/filter'
import {
  createFilterTheme,
  presetTheme,
  useFilterGroup,
  useRootRule,
} from '@fn-sphere/filter'
import { PlusIcon, TrashIcon } from 'lucide-react'
import type { ChangeEvent } from 'react'
import { useCallback } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

const componentsSpec = {
  Button: ({ children, ...props }) => {
    return (
      <Button variant="outline" size="sm" {...props}>
        {children}
      </Button>
    )
  },
  Input: ({ onChange, value, ...props }) => {
    const handleChange = useCallback(
      (e: ChangeEvent<HTMLInputElement>) => {
        onChange?.(e.target.value)
      },
      [onChange],
    )
    return (
      <Input className="h-8 min-w-[120px]" onChange={handleChange} value={value ?? ''} {...props} />
    )
  },
} satisfies Partial<FilterTheme['components']>

const templatesSpec = {
  FilterGroupContainer: ({ rule, children, ...props }) => {
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
          'relative flex flex-col items-start gap-2 rounded-md border bg-muted/30 px-3 py-2 pt-10',
          isRoot ? 'mt-8' : 'mt-6',
        )}
        {...props}
      >
        <div className="absolute top-0 flex -translate-y-1/2 gap-2">
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
  },
  FilterSelect: (props) => {
    const PresetFilterSelect = presetTheme.templates.FilterSelect
    return <PresetFilterSelect tryRetainArgs {...props} />
  },
} satisfies Partial<FilterTheme['templates']>

export const filterTheme = createFilterTheme({
  primitives: {
    select: ({ className, ...props }) => {
      return (
        <select
          className={cn(
            'h-8 min-w-[100px] rounded-md border border-input bg-background px-2 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
            className,
          )}
          {...props}
        />
      )
    },
  },
  components: componentsSpec,
  templates: templatesSpec,
})
