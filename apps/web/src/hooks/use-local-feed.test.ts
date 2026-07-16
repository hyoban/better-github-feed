import assert from 'node:assert/strict'

import { describe, it } from 'vite-plus/test'

import type { LiveProjection, LocalFeed } from '../local-feed/types'

import { ReactProjectionCache } from './use-local-feed'

class ManualScheduler {
  #nextId = 0
  readonly pending = new Map<number, { callback: () => void; delay: number }>()

  setTimeout = (callback: () => void, delay: number) => {
    const id = this.#nextId++
    this.pending.set(id, { callback, delay })
    return id
  }

  clearTimeout = (id: number) => {
    this.pending.delete(id)
  }

  run(delay: number) {
    for (const [id, task] of this.pending) {
      if (task.delay !== delay) continue
      this.pending.delete(id)
      task.callback()
    }
  }
}

describe('ReactProjectionCache', () => {
  it('keeps a reused render alive until it subscribes even after a long transition', () => {
    const scheduler = new ManualScheduler()
    let disposeCount = 0
    let observeCount = 0
    const live = {
      subscribe: () => () => undefined,
      getSnapshot: () => ({ kind: 'ready' as const, localRevision: 1, value: [] }),
      dispose: () => {
        disposeCount += 1
      },
    } satisfies LiveProjection<unknown>
    const feed = {
      observe: () => {
        observeCount += 1
        return live
      },
    } as unknown as LocalFeed
    const cache = new ReactProjectionCache(feed, scheduler)
    const projection = { kind: 'user-filters' as const }

    const first = cache.get(projection)
    assert.equal(observeCount, 0)
    const unsubscribe = first.live.subscribe(() => undefined)
    assert.equal(observeCount, 1)
    unsubscribe()
    assert.equal(
      [...scheduler.pending.values()].some(task => task.delay === 0),
      true,
    )

    const reused = cache.get(projection)
    assert.equal(reused.live, first.live)
    assert.equal(
      [...scheduler.pending.values()].some(task => task.delay === 0),
      false,
    )
    scheduler.run(0)
    scheduler.run(5_000)
    assert.equal(disposeCount, 0)

    const unsubscribeAgain = reused.live.subscribe(() => undefined)
    assert.equal(observeCount, 1)
    assert.equal(disposeCount, 0)
    unsubscribeAgain()
    scheduler.run(0)
    assert.equal(disposeCount, 1)
  })

  it('does not open a projection for an abandoned render', () => {
    const scheduler = new ManualScheduler()
    let observeCount = 0
    const feed = {
      observe: () => {
        observeCount += 1
        return {
          subscribe: () => () => undefined,
          getSnapshot: () => ({ kind: 'ready' as const, localRevision: 1, value: [] }),
          dispose: () => undefined,
        } satisfies LiveProjection<unknown>
      },
    } as unknown as LocalFeed
    const cache = new ReactProjectionCache(feed, scheduler)

    const rendered = cache.get({ kind: 'user-filters' })

    assert.equal(rendered.live.getSnapshot().kind, 'opening-local')
    assert.equal(observeCount, 0)
    scheduler.run(30_000)
    scheduler.run(0)
    const rerendered = cache.get({ kind: 'user-filters' })
    assert.notEqual(rerendered.live, rendered.live)
    assert.equal(observeCount, 0)
    const unsubscribe = rendered.live.subscribe(() => undefined)
    assert.equal(observeCount, 1)
    assert.equal(rendered.live.getSnapshot().kind, 'ready')
    unsubscribe()
    scheduler.run(0)
    cache.dispose()
  })
})
