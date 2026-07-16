export type ServiceWorkerUpdateTarget = EventTarget & {
  readonly state: string
}

export type ServiceWorkerUpdateRegistration = EventTarget & {
  readonly installing: ServiceWorkerUpdateTarget | null
  readonly waiting: ServiceWorkerUpdateTarget | null
}

export function watchForServiceWorkerUpdate<T extends ServiceWorkerUpdateTarget>(
  registration: ServiceWorkerUpdateRegistration & {
    readonly installing: T | null
    readonly waiting: T | null
  },
  hasController: () => boolean,
  onUpdateReady: (worker: T) => void,
) {
  const observed = new Set<T>()
  const offered = new Set<T>()

  const offerIfReady = (worker: T) => {
    if (worker.state !== 'installed' || !hasController() || offered.has(worker)) return
    offered.add(worker)
    onUpdateReady(worker)
  }

  const observe = (worker: T | null) => {
    if (!worker || observed.has(worker)) return
    observed.add(worker)
    offerIfReady(worker)
    worker.addEventListener('statechange', () => offerIfReady(worker))
  }

  observe(registration.waiting)
  observe(registration.installing)
  registration.addEventListener('updatefound', () => observe(registration.installing))
}
