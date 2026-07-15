import * as React from 'react'

const DESKTOP_BREAKPOINT = 1024 // lg breakpoint

function subscribeDesktop(callback: () => void) {
  const mql = window.matchMedia(`(min-width: ${DESKTOP_BREAKPOINT}px)`)
  mql.addEventListener('change', callback)
  return () => mql.removeEventListener('change', callback)
}

function getDesktopSnapshot() {
  return window.innerWidth >= DESKTOP_BREAKPOINT
}

function getDesktopServerSnapshot() {
  return true
}

export function useIsDesktop() {
  return React.useSyncExternalStore(subscribeDesktop, getDesktopSnapshot, getDesktopServerSnapshot)
}
