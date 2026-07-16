import assert from 'node:assert/strict'

import { describe, it } from 'vite-plus/test'

import {
  adoptOrTouchMediaCacheEntry,
  createMediaClientRegistry,
  createMediaWriteQueue,
  deleteMediaCacheEntryIfOwned,
  MEDIA_ORPHAN_GRACE_MS,
  mediaCacheRecordIsFresh,
  pruneMediaCaches,
  readMediaCacheEntry,
  rollbackStagedMediaCacheEntry,
  stageMediaCacheEntry,
  touchMediaCacheEntry,
  writeMediaCacheEntry,
} from '../service-worker/sw-media-context.js'

const binding = (ownerGithubId, generation, nonce = `nonce-${generation}`) => ({
  ownerGithubId,
  generation,
  nonce,
})

class MemoryCache {
  records = new Map()
  beforePut = null
  beforeDelete = null

  async put(request, response) {
    await this.beforePut?.(new Request(request))
    this.records.set(new Request(request).url, response.clone())
  }

  async match(request) {
    return this.records.get(new Request(request).url)?.clone()
  }

  async delete(request) {
    await this.beforeDelete?.(new Request(request))
    return this.records.delete(new Request(request).url)
  }

  async keys() {
    return [...this.records.keys()].map(url => new Request(url))
  }
}

class MemoryCacheStorage {
  caches = new Map()

  async open(name) {
    let cache = this.caches.get(name)
    if (!cache) {
      cache = new MemoryCache()
      this.caches.set(name, cache)
    }
    return cache
  }
}

class MemoryLockManager {
  tails = new Map()

  request(name, operation) {
    const previous = this.tails.get(name) ?? Promise.resolve()
    const queued = previous.catch(() => undefined).then(operation)
    const tail = queued.then(
      () => undefined,
      () => undefined,
    )
    this.tails.set(name, tail)
    return queued
  }
}

describe('service worker media client registry', () => {
  it('uses a shorter freshness window for opaque media responses', () => {
    assert.equal(
      mediaCacheRecordIsFresh({ cachedAt: 1_000, responseType: 'opaque' }, 300_999),
      true,
    )
    assert.equal(
      mediaCacheRecordIsFresh({ cachedAt: 1_000, responseType: 'opaque' }, 301_000),
      false,
    )
    assert.equal(
      mediaCacheRecordIsFresh({ cachedAt: 1_000, responseType: 'cors' }, 3_600_999),
      true,
    )
    assert.equal(mediaCacheRecordIsFresh({ cachedAt: 0 }, 1), false)
  })
  it('recovers client ownership after a worker restart and deletes every signed-out mapping', async () => {
    const cacheStorage = new MemoryCacheStorage()
    const firstWorker = createMediaClientRegistry(cacheStorage, 'https://feed.test')
    await firstWorker.set('client-a', binding('101', 1))
    await firstWorker.set('client-b', binding('101', 1))
    await firstWorker.set('client-c', binding('202', 2))

    const restartedWorker = createMediaClientRegistry(cacheStorage, 'https://feed.test')
    assert.deepEqual(await restartedWorker.get('client-a'), binding('101', 1))
    assert.deepEqual(await restartedWorker.get('client-c'), binding('202', 2))

    await restartedWorker.fenceAccount(binding('101', 3))
    const afterDeletion = createMediaClientRegistry(cacheStorage, 'https://feed.test')
    assert.equal(await afterDeletion.get('client-a'), null)
    assert.equal(await afterDeletion.get('client-b'), null)
    assert.deepEqual(await afterDeletion.get('client-c'), binding('202', 2))
  })

  it('orders sign-out deletion after an in-flight context write', async () => {
    const cacheStorage = new MemoryCacheStorage()
    const contextCache = await cacheStorage.open('better-github-feed-media-context-v1')
    let releasePut
    let markPutStarted
    const putStarted = new Promise(resolve => {
      markPutStarted = resolve
    })
    const putReleased = new Promise(resolve => {
      releasePut = resolve
    })
    contextCache.beforePut = async () => {
      markPutStarted()
      await putReleased
    }
    const registry = createMediaClientRegistry(cacheStorage, 'https://feed.test')

    const setting = registry.set('client-a', binding('101', 1))
    await putStarted
    const deleting = registry.fenceAccount(binding('101', 2))
    releasePut()
    await Promise.all([setting, deleting])

    const restartedWorker = createMediaClientRegistry(cacheStorage, 'https://feed.test')
    assert.equal(await restartedWorker.get('client-a'), null)
  })

  it('prunes client IDs left behind by ordinary page reloads', async () => {
    const cacheStorage = new MemoryCacheStorage()
    const registry = createMediaClientRegistry(cacheStorage, 'https://feed.test')
    await registry.set('reloaded-client', binding('101', 1))
    await registry.set('current-client', binding('101', 1))

    await registry.prune(new Set(['current-client']))

    const restartedWorker = createMediaClientRegistry(cacheStorage, 'https://feed.test')
    assert.equal(await restartedWorker.get('reloaded-client'), null)
    assert.deepEqual(await restartedWorker.get('current-client'), binding('101', 1))
  })

  it('rejects delayed account messages across generation and nonce fences', async () => {
    const cacheStorage = new MemoryCacheStorage()
    const registry = createMediaClientRegistry(cacheStorage, 'https://feed.test')
    const old = binding('101', 1, 'old')
    const locked = binding('101', 2, 'locked')
    const reactivated = binding('101', 3, 'reactivated')

    assert.equal(await registry.set('client-a', old), true)
    assert.equal(await registry.fenceAccount(locked), true)
    assert.equal(await registry.set('client-a', old), false)
    assert.equal(await registry.get('client-a'), null)
    assert.equal(await registry.set('client-a', reactivated), true)
    assert.equal(await registry.fenceAccount(locked), false)
    assert.deepEqual(await registry.get('client-a'), reactivated)

    const restartedWorker = createMediaClientRegistry(cacheStorage, 'https://feed.test')
    assert.deepEqual(await restartedWorker.get('client-a'), reactivated)

    const contextCache = await cacheStorage.open('better-github-feed-media-context-v1')
    const ownerFenceKeys = (await contextCache.keys()).filter(request =>
      new URL(request.url).pathname.startsWith('/__better_github_feed_media_fence__/101/'),
    )
    assert.equal(ownerFenceKeys.length, 1)
  })

  it('invalidates another worker instance that already warmed the client binding', async () => {
    const cacheStorage = new MemoryCacheStorage()
    const firstWorker = createMediaClientRegistry(cacheStorage, 'https://feed.test')
    const secondWorker = createMediaClientRegistry(cacheStorage, 'https://feed.test')
    const active = binding('101', 1, 'active')

    await firstWorker.set('client-a', active)
    assert.deepEqual(await secondWorker.get('client-a'), active)

    await firstWorker.fenceAccount(binding('101', 2, 'locked'))

    assert.equal(await secondWorker.get('client-a'), null)
    assert.equal(await secondWorker.isCurrent('client-a', active), false)
  })

  it('keeps a newer cross-worker fence authoritative after a delayed old write', async () => {
    const cacheStorage = new MemoryCacheStorage()
    const contextCache = await cacheStorage.open('better-github-feed-media-context-v1')
    const oldWorker = createMediaClientRegistry(cacheStorage, 'https://feed.test')
    const newWorker = createMediaClientRegistry(cacheStorage, 'https://feed.test')
    let releaseOldPut
    let markOldPutStarted
    const oldPutStarted = new Promise(resolve => {
      markOldPutStarted = resolve
    })
    const oldPutReleased = new Promise(resolve => {
      releaseOldPut = resolve
    })
    let blocked = false
    contextCache.beforePut = async request => {
      if (blocked || !new URL(request.url).pathname.endsWith('/101/1/old/active')) return
      blocked = true
      markOldPutStarted()
      await oldPutReleased
    }

    const delayedOldSet = oldWorker.set('client-a', binding('101', 1, 'old'))
    await oldPutStarted
    assert.equal(await newWorker.fenceAccount(binding('101', 2, 'locked')), true)
    releaseOldPut()
    assert.equal(await delayedOldSet, false)

    const restartedWorker = createMediaClientRegistry(cacheStorage, 'https://feed.test')
    assert.equal(await restartedWorker.get('client-a'), null)
    assert.equal(await restartedWorker.isFenced(binding('101', 2, 'locked')), true)
  })

  it('keeps the authoritative fence readable when history compaction fails', async () => {
    const cacheStorage = new MemoryCacheStorage()
    const registry = createMediaClientRegistry(cacheStorage, 'https://feed.test')
    await registry.set('client-a', binding('101', 1, 'old'))
    const contextCache = await cacheStorage.open('better-github-feed-media-context-v1')
    contextCache.beforeDelete = async request => {
      if (new URL(request.url).pathname.includes('/101/1/')) {
        throw new Error('quota bookkeeping failed')
      }
    }

    assert.equal(await registry.fenceAccount(binding('101', 2, 'locked')), true)
    assert.equal(await registry.isFenced(binding('101', 2, 'locked')), true)
  })
})

describe('service worker media cache writes', () => {
  const origin = 'https://feed.test'
  const request = new Request('https://avatars.test/user.png')

  it('rolls back the media object when metadata persistence fails', async () => {
    const media = new MemoryCache()
    const metadata = new MemoryCache()
    metadata.beforePut = async () => {
      throw new Error('metadata quota exceeded')
    }

    await assert.rejects(
      writeMediaCacheEntry({
        media,
        metadata,
        origin,
        request,
        response: new Response('old'),
        binding: binding('101', 1, 'old'),
        writeToken: 'old-write',
        now: 1_000,
      }),
      /metadata quota exceeded/,
    )
    assert.equal((await media.keys()).length, 0)
    assert.equal((await metadata.keys()).length, 0)
  })

  it('lets a stale generation delete only its own same-URL write', async () => {
    const media = new MemoryCache()
    const metadata = new MemoryCache()
    const oldBinding = binding('101', 1, 'old')
    const newBinding = binding('101', 2, 'new')
    const newRecord = await writeMediaCacheEntry({
      media,
      metadata,
      origin,
      request,
      response: new Response('new'),
      binding: newBinding,
      writeToken: 'new-write',
      now: 2_000,
    })
    const oldRecord = await writeMediaCacheEntry({
      media,
      metadata,
      origin,
      request,
      response: new Response('old'),
      binding: oldBinding,
      writeToken: 'old-write',
      now: 1_000,
    })

    await pruneMediaCaches(media, metadata, oldBinding, {
      maxEntries: 120,
      now: 3_000,
    })

    await deleteMediaCacheEntryIfOwned(media, metadata, origin, request, oldBinding, oldRecord)

    assert.equal(await media.match(oldRecord.cacheUrl), undefined)
    assert.equal(await (await media.match(newRecord.cacheUrl)).text(), 'new')
    assert.equal(
      (await readMediaCacheEntry(metadata, origin, request, newBinding)).writeToken,
      'new-write',
    )
  })

  it('adopts retained media after a verified same-owner unlock without granting the old generation', async () => {
    const cacheStorage = new MemoryCacheStorage()
    const registry = createMediaClientRegistry(cacheStorage, origin)
    const media = new MemoryCache()
    const metadata = new MemoryCache()
    const oldBinding = binding('101', 1, 'old')
    const unlockedBinding = binding('101', 2, 'unlocked')
    const otherOwner = binding('202', 3, 'other')

    assert.equal(await registry.set('old-client', oldBinding), true)
    const retainedRecord = await writeMediaCacheEntry({
      media,
      metadata,
      origin,
      request,
      response: new Response('retained-avatar'),
      binding: oldBinding,
      writeToken: 'retained-write',
      now: 1_000,
    })
    assert.equal(await registry.fenceAccount(oldBinding), true)
    assert.equal(await registry.set('new-client', unlockedBinding), true)

    const retained = await readMediaCacheEntry(metadata, origin, request, unlockedBinding)
    assert.equal(retained.writeToken, 'retained-write')
    assert.equal(await (await media.match(retained.cacheUrl)).text(), 'retained-avatar')
    assert.equal(await readMediaCacheEntry(metadata, origin, request, otherOwner), null)

    const adopted = await adoptOrTouchMediaCacheEntry({
      media,
      metadata,
      origin,
      request,
      response: (await media.match(retained.cacheUrl)).clone(),
      binding: unlockedBinding,
      record: retained,
      writeToken: 'unlocked-write',
      now: 2_000,
    })
    assert.equal(adopted.kind, 'adopted')
    assert.equal(adopted.record.cachedAt, retained.cachedAt)
    assert.equal(await registry.isCurrent('new-client', unlockedBinding), true)
    await deleteMediaCacheEntryIfOwned(
      media,
      metadata,
      origin,
      request,
      unlockedBinding,
      adopted.previous,
    )
    await pruneMediaCaches(media, metadata, unlockedBinding, {
      maxEntries: 120,
      now: 2_000,
    })

    assert.equal(
      await deleteMediaCacheEntryIfOwned(
        media,
        metadata,
        origin,
        request,
        oldBinding,
        adopted.record,
      ),
      false,
    )
    assert.equal(await (await media.match(adopted.record.cacheUrl)).text(), 'retained-avatar')
    assert.equal(
      (await readMediaCacheEntry(metadata, origin, request, unlockedBinding)).writeToken,
      'unlocked-write',
    )
    assert.equal(await readMediaCacheEntry(metadata, origin, request, oldBinding), null)
    assert.equal(await media.match(retainedRecord.cacheUrl), undefined)
  })

  it('serializes touch and revalidation maintenance across worker queues for one owner', async () => {
    const media = new MemoryCache()
    const metadata = new MemoryCache()
    const currentBinding = binding('101', 1, 'active')
    const initial = await writeMediaCacheEntry({
      media,
      metadata,
      origin,
      request,
      response: new Response('initial'),
      binding: currentBinding,
      writeToken: 'initial-write',
      now: 1_000,
    })
    const lockManager = new MemoryLockManager()
    const oldWorkerQueue = createMediaWriteQueue(lockManager)
    const newWorkerQueue = createMediaWriteQueue(lockManager)
    let markTouchStarted
    let releaseTouch
    const touchStarted = new Promise(resolve => {
      markTouchStarted = resolve
    })
    const touchReleased = new Promise(resolve => {
      releaseTouch = resolve
    })
    let blockTouch = true
    metadata.beforePut = async () => {
      if (!blockTouch) return
      blockTouch = false
      markTouchStarted()
      await touchReleased
    }

    const touching = oldWorkerQueue.run('101', () =>
      touchMediaCacheEntry(metadata, origin, request, currentBinding, initial, 2_000),
    )
    await touchStarted
    let revalidationStarted = false
    const revalidating = newWorkerQueue.run('101', async () => {
      revalidationStarted = true
      return writeMediaCacheEntry({
        media,
        metadata,
        origin,
        request,
        response: new Response('revalidated'),
        binding: currentBinding,
        writeToken: 'revalidated-write',
        now: 3_000,
      })
    })
    await Promise.resolve()
    assert.equal(revalidationStarted, false)

    releaseTouch()
    await Promise.all([touching, revalidating])

    const final = await readMediaCacheEntry(metadata, origin, request, currentBinding)
    assert.equal(final.writeToken, 'revalidated-write')
    assert.equal(await (await media.match(final.cacheUrl)).text(), 'revalidated')
  })

  it('rolls back a fenced same-generation stage without losing the previous object', async () => {
    const media = new MemoryCache()
    const metadata = new MemoryCache()
    const currentBinding = binding('101', 1, 'active')
    const previous = await writeMediaCacheEntry({
      media,
      metadata,
      origin,
      request,
      response: new Response('previous'),
      binding: currentBinding,
      writeToken: 'previous-write',
      now: 1_000,
    })
    const staged = await stageMediaCacheEntry({
      media,
      metadata,
      origin,
      request,
      response: new Response('staged'),
      binding: currentBinding,
      writeToken: 'staged-write',
      now: 2_000,
    })

    await rollbackStagedMediaCacheEntry({
      media,
      metadata,
      origin,
      request,
      binding: currentBinding,
      ...staged,
    })

    assert.equal(
      (await readMediaCacheEntry(metadata, origin, request, currentBinding)).writeToken,
      previous.writeToken,
    )
    assert.equal(await (await media.match(previous.cacheUrl)).text(), 'previous')
    assert.equal(await media.match(staged.record.cacheUrl), undefined)
  })

  it('applies the LRU bound across readable retained generations', async () => {
    const media = new MemoryCache()
    const metadata = new MemoryCache()
    const oldBinding = binding('101', 1, 'old')
    const currentBinding = binding('101', 2, 'current')
    const requests = [
      new Request('https://avatars.test/oldest.png'),
      new Request('https://avatars.test/middle.png'),
      new Request('https://avatars.test/newest.png'),
    ]
    for (const [index, mediaRequest] of requests.entries()) {
      await writeMediaCacheEntry({
        media,
        metadata,
        origin,
        request: mediaRequest,
        response: new Response(String(index)),
        binding: oldBinding,
        writeToken: `write-${index}`,
        now: index + 1,
      })
    }

    await pruneMediaCaches(media, metadata, currentBinding, { maxEntries: 2, now: 10_000 })

    assert.equal((await metadata.keys()).length, 2)
    assert.equal((await media.keys()).length, 2)
    assert.equal(await readMediaCacheEntry(metadata, origin, requests[0], currentBinding), null)
    assert.equal(
      (await readMediaCacheEntry(metadata, origin, requests[2], currentBinding)).writeToken,
      'write-2',
    )
  })

  it('reconciles old orphan media while preserving a possible in-flight write', async () => {
    const media = new MemoryCache()
    const metadata = new MemoryCache()
    const oldOrphan = new Request(
      `https://avatars.test/old.png?__better_github_feed_write_token=old&__better_github_feed_created_at=1`,
    )
    const freshOrphan = new Request(
      `https://avatars.test/fresh.png?__better_github_feed_write_token=fresh&__better_github_feed_created_at=${MEDIA_ORPHAN_GRACE_MS}`,
    )
    await media.put(oldOrphan, new Response('old'))
    await media.put(freshOrphan, new Response('fresh'))

    await pruneMediaCaches(media, metadata, binding('101', 2, 'new'), {
      maxEntries: 120,
      now: MEDIA_ORPHAN_GRACE_MS + 1,
    })

    assert.equal(await media.match(oldOrphan), undefined)
    assert.equal(await (await media.match(freshOrphan)).text(), 'fresh')
  })
})
