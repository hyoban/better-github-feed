import type { FilterTheme } from '@fn-sphere/filter'
import { createFilterTheme } from '@fn-sphere/filter'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

import { FilterThemeGroupContainer } from './filter-theme-group-container'
import { FilterThemeInput } from './filter-theme-input'
import { FilterThemeSelect } from './filter-theme-select'

const componentsSpec = {
  Button: ({ children, ...props }) => {
    return (
      <Button variant="outline" size="sm" {...props}>
        {children}
      </Button>
    )
  },
  Input: FilterThemeInput,
} satisfies Partial<FilterTheme['components']>

const templatesSpec = {
  FilterGroupContainer: FilterThemeGroupContainer,
  FilterSelect: FilterThemeSelect,
} satisfies Partial<FilterTheme['templates']>

export const filterTheme = createFilterTheme({
  primitives: {
    select: ({ className, ...props }) => {
      return (
        <select
          className={cn(
            'h-8 min-w-25 rounded-md border border-input bg-background px-2 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
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
