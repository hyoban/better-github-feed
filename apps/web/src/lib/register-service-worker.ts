import { recordPwaLifecycleEvent } from './pwa-diagnostics'
import { shouldActivateWaitingUpdate, watchForServiceWorkerUpdate } from './service-worker-update'

const SERVICE_WORKER_URL = '/sw.js'
const UPDATE_INTERVAL_MS = 60 * 60 * 1000
const ACTIVATION_GUARD_KEY = 'better-github-feed:pwa-activation-build'

type WaitingUpdateState = {
  buildId: string
  clientCount: number
}

async function readWaitingUpdateState(worker: ServiceWorker): Promise<WaitingUpdateState | null> {
  return new Promise(resolve => {
    const channel = new MessageChannel()
    let settled = false
    let timeout: number | undefined
    const finish = (value: WaitingUpdateState | null) => {
      if (settled) return
      settled = true
      if (timeout !== undefined) window.clearTimeout(timeout)
      channel.port1.close()
      resolve(value)
    }
    timeout = window.setTimeout(() => finish(null), 1500)
    channel.port1.addEventListener(
      'message',
      event => {
        const value = event.data as Partial<WaitingUpdateState> | null
        finish(
          value &&
            typeof value.buildId === 'string' &&
            Number.isSafeInteger(value.clientCount) &&
            value.clientCount! >= 0
            ? { buildId: value.buildId, clientCount: value.clientCount! }
            : null,
        )
      },
      { once: true },
    )
    channel.port1.start()
    try {
      worker.postMessage({ type: 'GET_UPDATE_ACTIVATION_STATE' }, [channel.port2])
    } catch {
      finish(null)
    }
  })
}

async function activateWaitingUpdateOnStartup(registration: ServiceWorkerRegistration) {
  const waiting = registration.waiting
  if (!waiting) return

  const state = await readWaitingUpdateState(waiting)
  let lastAttemptedBuildId: string | null = null
  try {
    lastAttemptedBuildId = window.sessionStorage.getItem(ACTIVATION_GUARD_KEY)
  } catch {
    // A reload guard is best-effort when session storage is unavailable.
  }
  if (!state || !shouldActivateWaitingUpdate(state, lastAttemptedBuildId)) {
    recordPwaLifecycleEvent('update-deferred')
    return
  }

  try {
    window.sessionStorage.setItem(ACTIVATION_GUARD_KEY, state.buildId)
  } catch {
    // Continue: controllerchange still prevents reloading before activation.
  }
  recordPwaLifecycleEvent('update-activation-requested')
  navigator.serviceWorker.addEventListener(
    'controllerchange',
    () => {
      recordPwaLifecycleEvent('update-activated')
      window.location.reload()
    },
    { once: true },
  )
  waiting.postMessage({ type: 'SKIP_WAITING' })
}

function scheduleUpdateChecks(registration: ServiceWorkerRegistration) {
  let lastCheckedAt = Date.now()
  const check = () => {
    if (document.visibilityState !== 'visible') return
    const now = Date.now()
    if (now - lastCheckedAt < UPDATE_INTERVAL_MS) return
    lastCheckedAt = now
    void registration.update().catch(() => recordPwaLifecycleEvent('update-check-failed'))
  }
  const interval = window.setInterval(check, UPDATE_INTERVAL_MS)
  window.addEventListener('focus', check)
  document.addEventListener('visibilitychange', check)
  window.addEventListener(
    'pagehide',
    () => {
      window.clearInterval(interval)
      window.removeEventListener('focus', check)
      document.removeEventListener('visibilitychange', check)
    },
    { once: true },
  )
}

export function registerServiceWorker() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return

  window.addEventListener('load', () => {
    void (async () => {
      const registration = await navigator.serviceWorker.register(SERVICE_WORKER_URL, {
        scope: '/',
        type: 'module',
        updateViaCache: 'none',
      })
      recordPwaLifecycleEvent('registered')
      watchForServiceWorkerUpdate(
        registration,
        () => navigator.serviceWorker.controller !== null,
        () => recordPwaLifecycleEvent('update-waiting'),
      )
      scheduleUpdateChecks(registration)
      await activateWaitingUpdateOnStartup(registration)
    })().catch(error => {
      recordPwaLifecycleEvent('registration-failed')
      console.error('Service Worker registration failed', error)
    })
  })
}
