import * as React from 'react'

const DESKTOP_BREAKPOINT = 1024 // lg breakpoint
const INLINE_DETAIL_BREAKPOINT = 768 // md breakpoint

function subscribeToBreakpoint(breakpoint: number, callback: () => void) {
  const mql = window.matchMedia(`(min-width: ${breakpoint}px)`)
  mql.addEventListener('change', callback)
  return () => mql.removeEventListener('change', callback)
}

function subscribeDesktop(callback: () => void) {
  return subscribeToBreakpoint(DESKTOP_BREAKPOINT, callback)
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

function subscribeInlineDetail(callback: () => void) {
  return subscribeToBreakpoint(INLINE_DETAIL_BREAKPOINT, callback)
}

function getInlineDetailSnapshot() {
  return window.innerWidth >= INLINE_DETAIL_BREAKPOINT
}

export function useHasInlineDetail() {
  return React.useSyncExternalStore(
    subscribeInlineDetail,
    getInlineDetailSnapshot,
    getDesktopServerSnapshot,
  )
}
