const LIFECYCLE_STORAGE_KEY = 'better-github-feed:pwa-lifecycle'
const MAX_EVENTS = 20

export type PwaLifecycleEvent = {
  readonly event: string
  readonly at: number
}

export type PwaDiagnostics = {
  readonly persisted: boolean | null
  readonly quotaUsagePercent: number | null
  readonly lifecycle: readonly PwaLifecycleEvent[]
}

function readLifecycleEvents(): PwaLifecycleEvent[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(LIFECYCLE_STORAGE_KEY) ?? '[]')
    return Array.isArray(value)
      ? value.filter(
          item =>
            item &&
            typeof item === 'object' &&
            typeof item.event === 'string' &&
            Number.isFinite(item.at),
        )
      : []
  } catch {
    return []
  }
}

export function recordPwaLifecycleEvent(event: string) {
  try {
    const lifecycle = [...readLifecycleEvents(), { event, at: Date.now() }].slice(-MAX_EVENTS)
    window.localStorage.setItem(LIFECYCLE_STORAGE_KEY, JSON.stringify(lifecycle))
  } catch {
    // Diagnostics must never affect startup or worker activation.
  }
}

export async function readPwaDiagnostics(): Promise<PwaDiagnostics> {
  const persisted = navigator.storage?.persisted
    ? await navigator.storage.persisted().catch(() => null)
    : null
  const estimate = navigator.storage?.estimate
    ? await navigator.storage.estimate().catch(() => null)
    : null
  const quotaUsagePercent =
    estimate?.usage !== undefined && estimate.quota
      ? Math.round((estimate.usage / estimate.quota) * 100)
      : null
  return { persisted, quotaUsagePercent, lifecycle: readLifecycleEvents() }
}
