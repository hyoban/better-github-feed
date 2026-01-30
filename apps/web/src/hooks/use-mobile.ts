import * as React from 'react'

const MOBILE_BREAKPOINT = 768
const DESKTOP_BREAKPOINT = 1024 // lg breakpoint

function subscribeMobile(callback: () => void) {
  const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
  mql.addEventListener('change', callback)
  return () => mql.removeEventListener('change', callback)
}

function getMobileSnapshot() {
  return window.innerWidth < MOBILE_BREAKPOINT
}

function getMobileServerSnapshot() {
  return false
}

export function useIsMobile() {
  return React.useSyncExternalStore(subscribeMobile, getMobileSnapshot, getMobileServerSnapshot)
}

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
