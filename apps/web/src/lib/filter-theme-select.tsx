import type { FilterTheme } from '@fn-sphere/filter'
import { presetTheme } from '@fn-sphere/filter'
import type { ComponentProps } from 'react'

export function FilterThemeSelect(props: ComponentProps<FilterTheme['templates']['FilterSelect']>) {
  const PresetFilterSelect = presetTheme.templates.FilterSelect
  return <PresetFilterSelect tryRetainArgs {...props} />
}
