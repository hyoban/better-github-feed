// oxlint-disable-next-line import/default -- Vite supplies the URL export for worker&url imports.
import serviceWorkerUrl from '../service-worker/sw.js?worker&url'

import { shellMarkupVersion } from './service-worker-version'
import { watchForServiceWorkerUpdate } from './service-worker-update'

export function registerServiceWorker() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return

  // Capture the server-rendered shell before React can add account-specific DOM.
  const shellMarkup = document.documentElement.outerHTML
  window.addEventListener('load', () => {
    void (async () => {
      const scriptUrl = new URL(serviceWorkerUrl, window.location.origin)
      scriptUrl.searchParams.set('shell', await shellMarkupVersion(shellMarkup))
      const registration = await navigator.serviceWorker.register(scriptUrl, {
        scope: '/',
        type: 'module',
      })
      watchForServiceWorkerUpdate(
        registration,
        () => navigator.serviceWorker.controller !== null,
        worker => worker.postMessage({ type: 'SKIP_WAITING' }),
      )
    })().catch(error => {
      console.error('Service Worker registration failed', error)
    })
  })
}
