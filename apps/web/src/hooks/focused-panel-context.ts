import { createContext } from 'react'

export type FocusedPanel = 'sidebar' | 'feed'

export interface FocusedPanelContextValue {
  focusedPanel: FocusedPanel
  setFocusedPanel: (panel: FocusedPanel) => void
}

export const FocusedPanelContext = createContext<FocusedPanelContextValue | null>(null)
