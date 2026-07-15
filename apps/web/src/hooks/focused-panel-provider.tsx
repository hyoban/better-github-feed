import type { ReactNode } from 'react'
import { useMemo, useState } from 'react'

import { FocusedPanelContext } from './focused-panel-context'
import type { FocusedPanel } from './focused-panel-context'

export function FocusedPanelProvider({ children }: { children: ReactNode }) {
  const [focusedPanel, setFocusedPanel] = useState<FocusedPanel>('feed')
  const contextValue = useMemo(
    () => ({ focusedPanel, setFocusedPanel }),
    [focusedPanel, setFocusedPanel],
  )

  return (
    <FocusedPanelContext.Provider value={contextValue}>{children}</FocusedPanelContext.Provider>
  )
}
