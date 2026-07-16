import type {
  EditableUserFilter,
  FeedView,
  LiveProjection,
  LocalFeed,
  Projection,
  ProjectionOutput,
  ProjectionSnapshot,
} from '../local-feed/types'
import { canonicalProjectionKey, canonicalizeProjection } from '../local-feed/incremental-sync'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from 'react'

type LocalFeedProviderProps = {
  feed: LocalFeed
  children: React.ReactNode
}

type CachedProjection = {
  projection: Projection
  live: LiveProjection<unknown> | null
  facade: LiveProjection<unknown>
  subscribers: number
  disposalTimer: number | null
  renderReservationTimer: number | null
}

type ProjectionFacadeHolder = {
  entry: CachedProjection
}

const openingProjectionSnapshot: ProjectionSnapshot<never> = { kind: 'opening-local' }
const RENDER_RESERVATION_MS = 30_000

export type ProjectionCacheScheduler = {
  setTimeout(callback: () => void, delay: number): number
  clearTimeout(timer: number): void
}

const defaultProjectionCacheScheduler: ProjectionCacheScheduler = {
  setTimeout(callback, delay) {
    return globalThis.setTimeout(callback, delay) as unknown as number
  },
  clearTimeout(timer) {
    globalThis.clearTimeout(timer)
  },
}

export class ReactProjectionCache {
  readonly #entries = new Map<string, CachedProjection>()
  #disposed = false

  constructor(
    readonly feed: LocalFeed,
    private readonly scheduler: ProjectionCacheScheduler = defaultProjectionCacheScheduler,
  ) {}

  get<P extends Projection>(projection: P) {
    const canonical = canonicalizeProjection(projection)
    const key = canonicalProjectionKey(canonical)
    const cached = this.#entries.get(key)
    if (cached) {
      this.#reserveRender(key, cached)
      return { key, live: cached.facade as LiveProjection<ProjectionOutput<P>> }
    }

    let holder: ProjectionFacadeHolder
    const facade: LiveProjection<unknown> = {
      getSnapshot: () => holder.entry.live?.getSnapshot() ?? openingProjectionSnapshot,
      subscribe: listener => this.#subscribeFacade(key, holder, listener),
      dispose: () => undefined,
    }
    const entry: CachedProjection = {
      projection: canonical,
      live: null,
      facade,
      subscribers: 0,
      disposalTimer: null,
      renderReservationTimer: null,
    }
    holder = { entry }
    this.#entries.set(key, entry)
    this.#reserveRender(key, entry)
    return { key, live: facade as LiveProjection<ProjectionOutput<P>> }
  }

  subscribe(key: string, listener: () => void) {
    const entry = this.#entries.get(key)
    if (!entry) return () => undefined
    return this.#subscribeEntry(key, entry, listener)
  }

  #subscribeFacade(key: string, holder: ProjectionFacadeHolder, listener: () => void) {
    if (this.#disposed) return () => undefined
    const current = this.#entries.get(key)
    if (current) {
      holder.entry = current
    } else {
      holder.entry.live = null
      this.#entries.set(key, holder.entry)
    }
    return this.#subscribeEntry(key, holder.entry, listener)
  }

  #subscribeEntry(key: string, entry: CachedProjection, listener: () => void) {
    if (entry.renderReservationTimer !== null) {
      this.scheduler.clearTimeout(entry.renderReservationTimer)
    }
    entry.renderReservationTimer = null
    if (entry.disposalTimer !== null) this.scheduler.clearTimeout(entry.disposalTimer)
    entry.disposalTimer = null
    entry.subscribers += 1
    entry.live ??= this.feed.observe(entry.projection) as LiveProjection<unknown>
    const unsubscribe = entry.live.subscribe(listener)
    let subscribed = true
    return () => {
      if (!subscribed) return
      subscribed = false
      unsubscribe()
      entry.subscribers -= 1
      if (entry.subscribers === 0) this.#scheduleDisposal(key, entry, 0)
    }
  }

  dispose() {
    this.#disposed = true
    for (const entry of this.#entries.values()) {
      if (entry.disposalTimer !== null) this.scheduler.clearTimeout(entry.disposalTimer)
      if (entry.renderReservationTimer !== null) {
        this.scheduler.clearTimeout(entry.renderReservationTimer)
      }
      entry.live?.dispose()
      entry.live = null
    }
    this.#entries.clear()
  }

  #scheduleDisposal(key: string, entry: CachedProjection, delay: number) {
    if (entry.disposalTimer !== null) this.scheduler.clearTimeout(entry.disposalTimer)
    entry.disposalTimer = this.scheduler.setTimeout(() => {
      entry.disposalTimer = null
      if (
        entry.subscribers > 0 ||
        entry.renderReservationTimer !== null ||
        this.#entries.get(key) !== entry
      ) {
        return
      }
      entry.live?.dispose()
      entry.live = null
      this.#entries.delete(key)
    }, delay)
  }

  #reserveRender(key: string, entry: CachedProjection) {
    if (entry.disposalTimer !== null) this.scheduler.clearTimeout(entry.disposalTimer)
    entry.disposalTimer = null
    if (entry.renderReservationTimer !== null) return
    entry.renderReservationTimer = this.scheduler.setTimeout(() => {
      entry.renderReservationTimer = null
      if (entry.subscribers === 0 && this.#entries.get(key) === entry) {
        this.#scheduleDisposal(key, entry, 0)
      }
    }, RENDER_RESERVATION_MS)
  }
}

export class StrictModeDeferredDisposer<T extends object> {
  readonly #tokens = new WeakMap<T, object>()

  mount(value: T, dispose: () => void) {
    const token = {}
    this.#tokens.set(value, token)
    return () => {
      queueMicrotask(() => {
        if (this.#tokens.get(value) !== token) return
        this.#tokens.delete(value)
        dispose()
      })
    }
  }
}

const LocalFeedContext = createContext<ReactProjectionCache | null>(null)

export function LocalFeedProvider({ feed, children }: LocalFeedProviderProps) {
  const cache = useMemo(() => new ReactProjectionCache(feed), [feed])
  const disposer = useMemo(() => new StrictModeDeferredDisposer<ReactProjectionCache>(), [])
  useEffect(() => disposer.mount(cache, () => cache.dispose()), [cache, disposer])

  return <LocalFeedContext.Provider value={cache}>{children}</LocalFeedContext.Provider>
}

function useProjectionCache() {
  const cache = useContext(LocalFeedContext)
  if (!cache) {
    throw new Error('LocalFeed hooks must be used within LocalFeedProvider')
  }
  return cache
}

export function useLocalFeedInstance() {
  return useProjectionCache().feed
}

function useProjection<P extends Projection>(
  projection: P,
): ProjectionSnapshot<ProjectionOutput<P>> {
  const cache = useProjectionCache()
  const { live } = cache.get(projection)
  const subscribe = useCallback((listener: () => void) => live.subscribe(listener), [live])

  return useSyncExternalStore(
    subscribe,
    () => live.getSnapshot(),
    () => live.getSnapshot(),
  ) as ProjectionSnapshot<ProjectionOutput<P>>
}

export function useFollowing(input: { sort: 'latest' | 'name' }) {
  return useProjection({ kind: 'following', ...input })
}

export function useVisibleFeed(input: { view: FeedView; first: number }) {
  return useProjection({ kind: 'visible-feed', ...input })
}

export function useActivity(id: string) {
  return useProjection({ kind: 'activity', id })
}

export function useUserFilters() {
  return useProjection({ kind: 'user-filters' })
}

export function useLocalFeedStatistics(input: { actors: FeedView['actors'] }) {
  return useProjection({ kind: 'statistics', ...input })
}

export function useLocalSyncStatus() {
  return useProjection({ kind: 'sync-status' })
}

export function useUserFilterActions() {
  const feed = useLocalFeedInstance()
  return useMemo(
    () => ({
      put: (filter: EditableUserFilter) => feed.commit({ kind: 'filter.put', filter }),
      delete: (id: string) => feed.commit({ kind: 'filter.delete', id }),
    }),
    [feed],
  )
}
