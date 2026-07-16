export type SyncTrigger = 'start' | 'focus' | 'online' | 'visible' | 'interval'

export interface SyncLifecyclePort {
  isOnline(): boolean
  isVisible(): boolean
  subscribe(listener: (trigger: SyncTrigger) => void): () => void
}

export function createBrowserSyncLifecyclePort(syncIntervalMs = 5 * 60 * 1000): SyncLifecyclePort {
  return {
    isOnline: () => navigator.onLine,
    isVisible: () => document.visibilityState === 'visible',
    subscribe(listener) {
      const onFocus = () => listener('focus')
      const onOnline = () => listener('online')
      const onVisibility = () => {
        if (document.visibilityState === 'visible') listener('visible')
      }
      window.addEventListener('focus', onFocus)
      window.addEventListener('online', onOnline)
      document.addEventListener('visibilitychange', onVisibility)
      const interval = window.setInterval(() => {
        if (document.visibilityState === 'visible') listener('interval')
      }, syncIntervalMs)
      queueMicrotask(() => listener('start'))

      return () => {
        window.removeEventListener('focus', onFocus)
        window.removeEventListener('online', onOnline)
        document.removeEventListener('visibilitychange', onVisibility)
        window.clearInterval(interval)
      }
    },
  }
}

export type ManualSyncLifecyclePort = SyncLifecyclePort & {
  emit(trigger: SyncTrigger): void
  setOnline(online: boolean): void
  setVisible(visible: boolean): void
}

export function createManualSyncLifecyclePort(options?: {
  online?: boolean
  visible?: boolean
}): ManualSyncLifecyclePort {
  let online = options?.online ?? true
  let visible = options?.visible ?? true
  const listeners = new Set<(trigger: SyncTrigger) => void>()
  return {
    isOnline: () => online,
    isVisible: () => visible,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    emit(trigger) {
      for (const listener of listeners) listener(trigger)
    },
    setOnline(value) {
      online = value
      if (value) this.emit('online')
    },
    setVisible(value) {
      visible = value
      if (value) this.emit('visible')
    },
  }
}
