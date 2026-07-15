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
    <Input className="h-8 min-w-[120px]" onChange={handleChange} value={value ?? ''} {...props} />
  )
}
