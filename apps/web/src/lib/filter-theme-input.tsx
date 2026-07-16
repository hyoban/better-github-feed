import type { FilterTheme } from '@fn-sphere/filter'
import type { ChangeEvent, ComponentProps } from 'react'
import { useCallback } from 'react'

import { Input } from '@/components/ui/input'

export function FilterThemeInput({
  onChange,
  value,
  ...props
}: ComponentProps<FilterTheme['components']['Input']>) {
  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      onChange?.(event.target.value)
    },
    [onChange],
  )

  return (
    <Input
      className="h-10 w-full min-w-0 sm:w-auto sm:min-w-30"
      onChange={handleChange}
      value={value ?? ''}
      {...props}
    />
  )
}
