import { cleanupOutdatedCaches, matchPrecache, precache } from 'workbox-precaching'

import {
  adoptOrTouchMediaCacheEntry,
  createMediaClientRegistry,
  createMediaWriteQueue,
  deleteMediaCacheEntryIfOwned,
  mediaCacheRecordIsFresh,
  pruneMediaCaches,
  readMediaCacheEntry,
  rollbackStagedMediaCacheEntry,
  stageMediaCacheEntry,
} from './sw-media-context.js'

const PRECACHE_MANIFEST = globalThis.__WB_MANIFEST
const BUILD_ID = PRECACHE_MANIFEST.map(
  entry => `${typeof entry === 'string' ? entry : entry.url}:${entry.revision ?? ''}`,
)
  .sort()
  .join('|')

precache(PRECACHE_MANIFEST)
cleanupOutdatedCaches()

const MEDIA_CACHE_PREFIX = 'better-github-feed-media-v1:'
const MEDIA_METADATA_CACHE_PREFIX = 'better-github-feed-media-metadata-v1:'
const MAX_MEDIA_ENTRIES = 120
const mediaAccountsByClient = new Map()
const mediaClientRegistry = createMediaClientRegistry(
  caches,
  globalThis.location.origin,
  mediaAccountsByClient,
)
const mediaMutationLocksSupported = typeof globalThis.navigator?.locks?.request === 'function'
const mediaWriteQueue = createMediaWriteQueue(globalThis.navigator?.locks)

function isApiRequest(url) {
  return url.origin === globalThis.location.origin && url.pathname.startsWith('/api/')
}

function isGithubAccountId(value) {
  return typeof value === 'string' && /^[1-9]\d*$/.test(value)
}

function accountBinding(message) {
  return {
    ownerGithubId: message.ownerGithubId,
    generation: message.generation,
    nonce: message.nonce,
  }
}

function mediaCacheNames(ownerGithubId) {
  const suffix = encodeURIComponent(ownerGithubId)
  return [`${MEDIA_CACHE_PREFIX}${suffix}`, `${MEDIA_METADATA_CACHE_PREFIX}${suffix}`]
}

function trackMediaWrite(ownerGithubId, operation) {
  // A local queue cannot protect metadata from an overlapping old/new worker pair.
  // Browsers without worker Web Locks keep retained media read-only instead.
  if (!mediaMutationLocksSupported) return Promise.resolve()
  return mediaWriteQueue.run(ownerGithubId, operation)
}

async function maintainCachedMedia({
  account,
  clientId,
  request,
  cached,
  cachedMetadata,
  media,
  metadata,
}) {
  if (!(await mediaClientRegistry.isCurrent(clientId, account))) return
  const result = await adoptOrTouchMediaCacheEntry({
    media,
    metadata,
    origin: globalThis.location.origin,
    request,
    response: cached.clone(),
    binding: account,
    record: cachedMetadata,
    writeToken: crypto.randomUUID(),
    now: Date.now(),
  })
  if (!result || result.kind === 'touched') return
  if (!(await mediaClientRegistry.isCurrent(clientId, account))) {
    await rollbackStagedMediaCacheEntry({
      media,
      metadata,
      origin: globalThis.location.origin,
      request,
      binding: account,
      record: result.record,
      previous: result.previous,
    })
    return
  }
  await deleteMediaCacheEntryIfOwned(
    media,
    metadata,
    globalThis.location.origin,
    request,
    account,
    result.previous,
  )
  await pruneMediaCaches(media, metadata, account, {
    maxEntries: MAX_MEDIA_ENTRIES,
  })
}

async function serveAccountMedia(account, clientId, request) {
  const { ownerGithubId } = account
  const [mediaName, metadataName] = mediaCacheNames(ownerGithubId)
  let media
  let metadata
  try {
    const accountCaches = await Promise.all([caches.open(mediaName), caches.open(metadataName)])
    media = accountCaches[0]
    metadata = accountCaches[1]
  } catch {
    return fetch(request)
  }
  if (!(await mediaClientRegistry.isCurrent(clientId, account))) return fetch(request)
  const cachedMetadata = await readMediaCacheEntry(
    metadata,
    globalThis.location.origin,
    request,
    account,
  )
  const cached = cachedMetadata ? await media.match(cachedMetadata.cacheUrl) : null
  if (cached && mediaCacheRecordIsFresh(cachedMetadata, Date.now())) {
    if (!(await mediaClientRegistry.isCurrent(clientId, account))) return fetch(request)
    await trackMediaWrite(ownerGithubId, async () => {
      try {
        await maintainCachedMedia({
          account,
          clientId,
          request,
          cached,
          cachedMetadata,
          media,
          metadata,
        })
      } catch {
        // LRU bookkeeping is best-effort.
      }
    })
    return cached
  }

  let response
  try {
    response = await fetch(request)
  } catch (error) {
    if (cached && (await mediaClientRegistry.isCurrent(clientId, account))) {
      await trackMediaWrite(ownerGithubId, async () => {
        try {
          await maintainCachedMedia({
            account,
            clientId,
            request,
            cached,
            cachedMetadata,
            media,
            metadata,
          })
        } catch {
          // Retained media is still safe to serve when adoption bookkeeping fails.
        }
      })
      if (await mediaClientRegistry.isCurrent(clientId, account)) return cached
    }
    throw error
  }
  if (
    (response.ok || response.type === 'opaque') &&
    (await mediaClientRegistry.isCurrent(clientId, account))
  ) {
    await trackMediaWrite(ownerGithubId, async () => {
      try {
        if (!(await mediaClientRegistry.isCurrent(clientId, account))) return
        const now = Date.now()
        const staged = await stageMediaCacheEntry({
          media,
          metadata,
          origin: globalThis.location.origin,
          request,
          response: response.clone(),
          binding: account,
          writeToken: crypto.randomUUID(),
          now,
        })
        if (!(await mediaClientRegistry.isCurrent(clientId, account))) {
          await rollbackStagedMediaCacheEntry({
            media,
            metadata,
            origin: globalThis.location.origin,
            request,
            binding: account,
            ...staged,
          })
          return
        }
        if (staged.previous?.writeToken !== staged.record.writeToken) {
          await deleteMediaCacheEntryIfOwned(
            media,
            metadata,
            globalThis.location.origin,
            request,
            account,
            staged.previous,
          )
        }
        await pruneMediaCaches(media, metadata, account, {
          maxEntries: MAX_MEDIA_ENTRIES,
          now,
        })
      } catch {
        // Media caching is best-effort and must never make an online image unavailable.
      }
    })
  } else if (cached && cachedMetadata) {
    await trackMediaWrite(ownerGithubId, async () => {
      if (!(await mediaClientRegistry.isCurrent(clientId, account))) return
      await deleteMediaCacheEntryIfOwned(
        media,
        metadata,
        globalThis.location.origin,
        request,
        account,
        cachedMetadata,
      ).catch(() => undefined)
    })
  }
  return response
}

async function pruneMediaClientContexts(preserveClientId) {
  const clients = await globalThis.clients.matchAll({
    includeUncontrolled: true,
    type: 'window',
  })
  const activeClientIds = new Set(clients.map(client => client.id))
  if (preserveClientId) activeClientIds.add(preserveClientId)
  await mediaClientRegistry.prune(activeClientIds)
}

globalThis.addEventListener('activate', event => {
  event.waitUntil(
    Promise.all([
      caches.keys().then(async keys => {
        const legacyShellDeletes = []
        for (const key of keys) {
          if (key.startsWith('better-github-feed-shell-')) {
            legacyShellDeletes.push(caches.delete(key))
          }
        }
        await Promise.all(legacyShellDeletes)
      }),
      (async () => {
        await pruneMediaClientContexts()
        await globalThis.clients.claim()
      })(),
    ]),
  )
})

globalThis.addEventListener('message', event => {
  const message = event.data
  if (!message || typeof message !== 'object') return

  if (message.type === 'SKIP_WAITING') {
    event.waitUntil(globalThis.skipWaiting())
    return
  }

  if (message.type === 'GET_UPDATE_ACTIVATION_STATE') {
    event.waitUntil(
      globalThis.clients.matchAll({ includeUncontrolled: true, type: 'window' }).then(clients =>
        event.ports[0]?.postMessage({
          buildId: BUILD_ID,
          clientCount: clients.length,
        }),
      ),
    )
    return
  }

  const sourceId = event.source?.id
  if (!sourceId) return

  if (message.type === 'SET_MEDIA_ACCOUNT') {
    event.waitUntil(
      (async () => {
        await mediaClientRegistry.set(
          sourceId,
          isGithubAccountId(message.ownerGithubId) ? accountBinding(message) : null,
        )
        await pruneMediaClientContexts(sourceId)
      })(),
    )
    return
  }

  if (message.type === 'FENCE_MEDIA_ACCOUNT' && isGithubAccountId(message.ownerGithubId)) {
    event.waitUntil(
      mediaClientRegistry
        .fenceAccount(accountBinding(message))
        .then(ok => event.ports[0]?.postMessage({ ok }))
        .catch(() => event.ports[0]?.postMessage({ ok: false })),
    )
    return
  }

  if (message.type === 'DELETE_MEDIA_ACCOUNT' && isGithubAccountId(message.ownerGithubId)) {
    const deletion = (async () => {
      try {
        const binding = accountBinding(message)
        const applied = await mediaClientRegistry.fenceAccount(binding)
        if (!applied) {
          event.ports[0]?.postMessage({ ok: false })
          return
        }
        await mediaWriteQueue.drain(message.ownerGithubId)
        if (!(await mediaClientRegistry.isFenced(binding))) {
          event.ports[0]?.postMessage({ ok: false })
          return
        }
        await Promise.all(mediaCacheNames(message.ownerGithubId).map(name => caches.delete(name)))
        event.ports[0]?.postMessage({ ok: true })
      } catch {
        event.ports[0]?.postMessage({ ok: false })
      }
    })()
    event.waitUntil(deletion)
  }
})

globalThis.addEventListener('fetch', event => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (isApiRequest(url)) return

  if (
    request.destination === 'image' &&
    url.origin !== globalThis.location.origin &&
    (url.protocol === 'https:' || url.protocol === 'http:')
  ) {
    event.respondWith(
      mediaClientRegistry
        .get(event.clientId)
        .then(mediaAccount =>
          mediaAccount ? serveAccountMedia(mediaAccount, event.clientId, request) : fetch(request),
        )
        .catch(() => fetch(request)),
    )
    return
  }

  if (url.origin !== globalThis.location.origin) return

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => response)
        .catch(async error => {
          const fallback = await matchPrecache('/index.html')
          if (fallback) return fallback
          throw error
        }),
    )
    return
  }

  event.respondWith(
    (async () => {
      const cached = await matchPrecache(request)
      if (cached) return cached
      return fetch(request)
    })(),
  )
})
