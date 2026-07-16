import assert from 'node:assert/strict'

import { describe, it } from 'vite-plus/test'

import { shouldActivateWaitingUpdate, watchForServiceWorkerUpdate } from './service-worker-update'

class FakeWorker extends EventTarget {
  state = 'installing'

  finishInstall() {
    this.state = 'installed'
    this.dispatchEvent(new Event('statechange'))
  }
}

class FakeRegistration extends EventTarget {
  installing: FakeWorker | null = null
  waiting: FakeWorker | null = null
}

describe('service worker update detection', () => {
  it('offers an installed update when the page already has a controller', () => {
    const registration = new FakeRegistration()
    const worker = new FakeWorker()
    registration.installing = worker
    const offered: FakeWorker[] = []

    watchForServiceWorkerUpdate(
      registration,
      () => true,
      update => offered.push(update),
    )
    worker.finishInstall()

    assert.deepEqual(offered, [worker])
  })

  it('does not treat the first service worker installation as an update', () => {
    const registration = new FakeRegistration()
    const worker = new FakeWorker()
    registration.installing = worker
    const offered: FakeWorker[] = []

    watchForServiceWorkerUpdate(
      registration,
      () => false,
      update => offered.push(update),
    )
    worker.finishInstall()

    assert.deepEqual(offered, [])
  })

  it('offers a worker that was already waiting when the page loaded', () => {
    const registration = new FakeRegistration()
    const worker = new FakeWorker()
    worker.finishInstall()
    registration.waiting = worker
    const offered: FakeWorker[] = []

    watchForServiceWorkerUpdate(
      registration,
      () => true,
      update => offered.push(update),
    )

    assert.deepEqual(offered, [worker])
  })
})

describe('quiet service worker activation', () => {
  it('activates a waiting build only when the current page is the sole client', () => {
    assert.equal(
      shouldActivateWaitingUpdate({ buildId: 'build-b', clientCount: 1 }, 'build-a'),
      true,
    )
    assert.equal(
      shouldActivateWaitingUpdate({ buildId: 'build-b', clientCount: 2 }, 'build-a'),
      false,
    )
  })

  it('guards against reloading the same waiting build twice', () => {
    assert.equal(
      shouldActivateWaitingUpdate({ buildId: 'build-b', clientCount: 1 }, 'build-b'),
      false,
    )
    assert.equal(shouldActivateWaitingUpdate(null, null), false)
  })
})
