export const MEDIA_CONTEXT_CACHE = 'better-github-feed-media-context-v1'

const MEDIA_CONTEXT_PATH = '/__better_github_feed_media_context__/'
const MEDIA_FENCE_PATH = '/__better_github_feed_media_fence__/'
const MEDIA_METADATA_PATH = '/__better_github_feed_media_lru__/'
const MEDIA_CACHE_TOKEN_PARAM = '__better_github_feed_write_token'
const MEDIA_CACHE_CREATED_AT_PARAM = '__better_github_feed_created_at'
const MEDIA_CACHE_GENERATION_PARAM = '__better_github_feed_generation'
const MEDIA_CACHE_NONCE_PARAM = '__better_github_feed_nonce'

export const MEDIA_ORPHAN_GRACE_MS = 60 * 1000

function isGithubAccountId(value) {
  return typeof value === 'string' && /^[1-9]\d*$/.test(value)
}

function isAccountBinding(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    isGithubAccountId(value.ownerGithubId) &&
    Number.isSafeInteger(value.generation) &&
    value.generation >= 0 &&
    typeof value.nonce === 'string' &&
    value.nonce.length > 0 &&
    value.nonce.length <= 200
  )
}

function sameBinding(left, right) {
  return (
    left?.ownerGithubId === right?.ownerGithubId &&
    left?.generation === right?.generation &&
    left?.nonce === right?.nonce
  )
}

function bindingCanReadRecord(binding, record) {
  if (!isAccountBinding(binding) || !isMediaMetadataRecord(record)) return false
  if (binding.ownerGithubId !== record.ownerGithubId) return false
  if (record.generation < binding.generation) return true
  return sameBinding(binding, record)
}

function contextRequest(origin, clientId) {
  return new Request(new URL(`${MEDIA_CONTEXT_PATH}${encodeURIComponent(clientId)}`, origin))
}

function fencePrefix(origin, ownerGithubId) {
  return new URL(`${MEDIA_FENCE_PATH}${encodeURIComponent(ownerGithubId)}/`, origin).pathname
}

function legacyFencePath(origin, ownerGithubId) {
  return new URL(`${MEDIA_FENCE_PATH}${encodeURIComponent(ownerGithubId)}`, origin).pathname
}

function fenceRequest(origin, binding, state) {
  const suffix = [
    encodeURIComponent(binding.ownerGithubId),
    binding.generation,
    encodeURIComponent(binding.nonce),
    state,
  ].join('/')
  return new Request(new URL(`${MEDIA_FENCE_PATH}${suffix}`, origin))
}

function isContextRequest(request) {
  return new URL(request.url).pathname.startsWith(MEDIA_CONTEXT_PATH)
}

async function readContext(response) {
  try {
    const record = await response?.json()
    return record?.kind === 'client-context' &&
      typeof record.clientId === 'string' &&
      isAccountBinding(record)
      ? record
      : null
  } catch {
    return null
  }
}

async function readFence(response) {
  try {
    const record = await response?.json()
    return record?.kind === 'account-fence' &&
      (record.state === 'active' || record.state === 'fenced') &&
      isAccountBinding(record)
      ? record
      : null
  } catch {
    return null
  }
}

function bindingRecord(binding) {
  return {
    ownerGithubId: binding.ownerGithubId,
    generation: binding.generation,
    nonce: binding.nonce,
  }
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
  })
}

async function authoritativeFence(cache, origin, ownerGithubId) {
  const prefix = fencePrefix(origin, ownerGithubId)
  const legacyPath = legacyFencePath(origin, ownerGithubId)
  const keys = (await cache.keys()).filter(request => {
    const path = new URL(request.url).pathname
    return path === legacyPath || path.startsWith(prefix)
  })
  const entries = await Promise.all(
    keys.map(async key => ({ key, record: await readFence(await cache.match(key)) })),
  )
  let current = null
  for (const { record } of entries) {
    if (!record || record.ownerGithubId !== ownerGithubId) continue
    if (!current || record.generation > current.generation) {
      current = record
      continue
    }
    if (record.generation !== current.generation) continue
    if (record.nonce !== current.nonce) {
      current = {
        kind: 'account-fence',
        state: 'conflict',
        ownerGithubId,
        generation: record.generation,
        nonce: null,
      }
      continue
    }
    if (current.state !== 'conflict' && record.state === 'fenced') current = record
  }
  if (current) {
    await Promise.allSettled(
      entries.flatMap(({ key, record }) =>
        !record || record.generation < current.generation ? [cache.delete(key)] : [],
      ),
    )
  }
  return current
}

export function mediaCacheRecordIsFresh(record, now) {
  if (!record || !Number.isFinite(record.cachedAt) || record.cachedAt <= 0) return false
  const ttl = record.responseType === 'opaque' ? 5 * 60 * 1000 : 60 * 60 * 1000
  const age = now - record.cachedAt
  return age >= 0 && age < ttl
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

async function mediaMetadataRequest(origin, request, binding) {
  const key = await sha256(
    [request.url, binding.ownerGithubId, binding.generation, binding.nonce].join('\0'),
  )
  return new Request(new URL(`${MEDIA_METADATA_PATH}${key}`, origin))
}

function mediaStorageRequest(request, binding, writeToken, createdAt) {
  const url = new URL(request.url)
  url.searchParams.set(MEDIA_CACHE_TOKEN_PARAM, writeToken)
  url.searchParams.set(MEDIA_CACHE_CREATED_AT_PARAM, String(createdAt))
  url.searchParams.set(MEDIA_CACHE_GENERATION_PARAM, String(binding.generation))
  url.searchParams.set(MEDIA_CACHE_NONCE_PARAM, binding.nonce)
  return new Request(url)
}

function readMediaStorageCreatedAt(request) {
  const value = Number(new URL(request.url).searchParams.get(MEDIA_CACHE_CREATED_AT_PARAM))
  return Number.isFinite(value) && value >= 0 ? value : null
}

function bindingCanDeleteStoredRequest(binding, request) {
  const url = new URL(request.url)
  const generation = Number(url.searchParams.get(MEDIA_CACHE_GENERATION_PARAM))
  const nonce = url.searchParams.get(MEDIA_CACHE_NONCE_PARAM)
  if (!Number.isSafeInteger(generation) || generation < 0 || !nonce) return true
  if (generation < binding.generation) return true
  return generation === binding.generation && nonce === binding.nonce
}

function isMediaMetadataRecord(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    value.kind === 'media-entry' &&
    typeof value.url === 'string' &&
    typeof value.cacheUrl === 'string' &&
    isAccountBinding(value) &&
    typeof value.writeToken === 'string' &&
    value.writeToken.length > 0 &&
    value.writeToken.length <= 200 &&
    Number.isFinite(value.touchedAt) &&
    Number.isFinite(value.cachedAt) &&
    typeof value.responseType === 'string'
  )
}

async function readMediaMetadataResponse(response) {
  try {
    const record = await response?.json()
    return isMediaMetadataRecord(record) ? record : null
  } catch {
    return null
  }
}

function mediaMetadataResponse(record) {
  return jsonResponse(record)
}

async function readExactMediaCacheEntry(metadata, origin, request, binding) {
  const key = await mediaMetadataRequest(origin, request, binding)
  const record = await readMediaMetadataResponse(await metadata.match(key))
  return record?.url === request.url && sameBinding(record, binding) ? record : null
}

export async function readMediaCacheEntry(metadata, origin, request, binding) {
  if (!isAccountBinding(binding)) return null
  const exact = await readExactMediaCacheEntry(metadata, origin, request, binding)
  if (exact) return exact

  const records = await Promise.all(
    (await metadata.keys()).map(async key => readMediaMetadataResponse(await metadata.match(key))),
  )
  return (
    records
      .filter(record => record?.url === request.url && bindingCanReadRecord(binding, record))
      .sort(
        (left, right) => right.generation - left.generation || right.touchedAt - left.touchedAt,
      )[0] ?? null
  )
}

export async function stageMediaCacheEntry({
  media,
  metadata,
  origin,
  request,
  response,
  binding,
  writeToken,
  now,
  cachedAt = now,
  responseType = response.type,
}) {
  if (!isAccountBinding(binding)) throw new TypeError('A valid account binding is required')
  if (typeof writeToken !== 'string' || writeToken.length === 0 || writeToken.length > 200) {
    throw new TypeError('A valid media write token is required')
  }
  const previous = await readMediaCacheEntry(metadata, origin, request, binding)
  const cacheRequest = mediaStorageRequest(request, binding, writeToken, now)
  const metadataKey = await mediaMetadataRequest(origin, request, binding)
  const record = {
    kind: 'media-entry',
    url: request.url,
    cacheUrl: cacheRequest.url,
    ...bindingRecord(binding),
    writeToken,
    touchedAt: now,
    cachedAt,
    responseType,
  }

  await media.put(cacheRequest, response)
  try {
    await metadata.put(metadataKey, mediaMetadataResponse(record))
  } catch (error) {
    await Promise.allSettled([media.delete(cacheRequest)])
    throw error
  }

  return { record, previous }
}

export async function writeMediaCacheEntry({
  media,
  metadata,
  origin,
  request,
  response,
  binding,
  writeToken,
  now,
}) {
  const { record, previous } = await stageMediaCacheEntry({
    media,
    metadata,
    origin,
    request,
    response,
    binding,
    writeToken,
    now,
  })

  if (previous && previous.writeToken !== writeToken) {
    await deleteMediaCacheEntryIfOwned(media, metadata, origin, request, binding, previous)
  }
  return record
}

export async function touchMediaCacheEntry(metadata, origin, request, binding, record, now) {
  if (!sameBinding(binding, record)) return false
  const current = await readExactMediaCacheEntry(metadata, origin, request, binding)
  if (!current || current.writeToken !== record.writeToken) return false
  const metadataKey = await mediaMetadataRequest(origin, request, binding)
  await metadata.put(metadataKey, mediaMetadataResponse({ ...current, touchedAt: now }))
  return true
}

export async function adoptOrTouchMediaCacheEntry({
  media,
  metadata,
  origin,
  request,
  response,
  binding,
  record,
  writeToken,
  now,
}) {
  if (!bindingCanReadRecord(binding, record)) return null
  if (sameBinding(binding, record)) {
    return (await touchMediaCacheEntry(metadata, origin, request, binding, record, now))
      ? { kind: 'touched', record }
      : null
  }

  const source = await readExactMediaCacheEntry(metadata, origin, request, bindingRecord(record))
  if (!source || source.writeToken !== record.writeToken) return null
  const staged = await stageMediaCacheEntry({
    media,
    metadata,
    origin,
    request,
    response,
    binding,
    writeToken,
    now,
    cachedAt: source.cachedAt,
    responseType: source.responseType,
  })
  return { kind: 'adopted', record: staged.record, previous: source }
}

export async function rollbackStagedMediaCacheEntry({
  media,
  metadata,
  origin,
  request,
  binding,
  record,
  previous,
}) {
  try {
    const current = await readExactMediaCacheEntry(metadata, origin, request, binding)
    if (current?.writeToken === record.writeToken) {
      const metadataKey = await mediaMetadataRequest(origin, request, binding)
      if (previous && sameBinding(previous, binding) && (await media.match(previous.cacheUrl))) {
        await metadata.put(metadataKey, mediaMetadataResponse(previous))
      } else {
        await metadata.delete(metadataKey)
      }
    }
  } finally {
    await media.delete(record.cacheUrl)
  }
}

export async function deleteMediaCacheEntryIfOwned(
  media,
  metadata,
  origin,
  request,
  binding,
  record,
) {
  if (!bindingCanReadRecord(binding, record)) return false
  const recordBinding = bindingRecord(record)
  const current = await readExactMediaCacheEntry(metadata, origin, request, recordBinding)
  const deletions = [media.delete(record.cacheUrl)]
  if (current?.writeToken === record.writeToken) {
    deletions.push(metadata.delete(await mediaMetadataRequest(origin, request, recordBinding)))
  }
  await Promise.allSettled(deletions)
  return true
}

export async function pruneMediaCaches(media, metadata, binding, { maxEntries, now = Date.now() }) {
  const metadataKeys = await metadata.keys()
  const parsed = await Promise.all(
    metadataKeys.map(async key => {
      const record = await readMediaMetadataResponse(await metadata.match(key))
      return {
        key,
        record,
        cached: record ? Boolean(await media.match(record.cacheUrl)) : false,
      }
    }),
  )
  const candidates = []
  const protectedRecords = []
  const cleanup = []
  for (const { key, record, cached } of parsed) {
    if (!record) {
      cleanup.push(metadata.delete(key))
      continue
    }
    if (record.ownerGithubId !== binding.ownerGithubId) {
      // Account cache names are owner-scoped. A mismatched record is never readable.
      cleanup.push(metadata.delete(key), media.delete(record.cacheUrl))
      continue
    }
    if (!bindingCanReadRecord(binding, record)) {
      // A delayed old worker must never prune a newer generation (or a nonce conflict).
      protectedRecords.push(record)
      continue
    }
    if (!cached) {
      cleanup.push(metadata.delete(key), media.delete(record.cacheUrl))
      continue
    }
    candidates.push({ key, record })
  }
  candidates.sort((left, right) => right.record.touchedAt - left.record.touchedAt)
  const retained = candidates.slice(0, maxEntries)
  for (const { key, record } of candidates.slice(maxEntries)) {
    cleanup.push(
      (async () => {
        const current = await readMediaMetadataResponse(await metadata.match(key))
        if (current?.writeToken === record.writeToken) await metadata.delete(key)
      })(),
      media.delete(record.cacheUrl),
    )
  }
  await Promise.allSettled(cleanup)

  const liveMediaUrls = new Set([
    ...retained.map(({ record }) => record.cacheUrl),
    ...protectedRecords.map(record => record.cacheUrl),
  ])
  const mediaKeys = await media.keys()
  await Promise.allSettled(
    mediaKeys.flatMap(key => {
      if (liveMediaUrls.has(key.url)) return []
      if (!bindingCanDeleteStoredRequest(binding, key)) return []
      const createdAt = readMediaStorageCreatedAt(key)
      if (createdAt !== null && now - createdAt < MEDIA_ORPHAN_GRACE_MS) return []
      return [media.delete(key)]
    }),
  )
}

export function createMediaWriteQueue(lockManager) {
  const tails = new Map()

  function run(ownerGithubId, operation) {
    const previous = tails.get(ownerGithubId) ?? Promise.resolve()
    const queued = previous
      .catch(() => undefined)
      .then(() =>
        typeof lockManager?.request === 'function'
          ? lockManager.request(`better-github-feed-media:${ownerGithubId}`, operation)
          : operation(),
      )
    const tail = queued.then(
      () => undefined,
      () => undefined,
    )
    tails.set(ownerGithubId, tail)
    void tail.then(() => {
      if (tails.get(ownerGithubId) === tail) tails.delete(ownerGithubId)
    })
    return queued
  }

  return {
    run,
    drain(ownerGithubId) {
      return run(ownerGithubId, () => undefined)
    },
  }
}

function activeFenceMatches(binding, fence) {
  return fence?.state === 'active' && sameBinding(binding, fence)
}

function fencedFenceMatches(binding, fence) {
  return fence?.state === 'fenced' && sameBinding(binding, fence)
}

function candidateCanAdvance(candidate, current) {
  if (!current) return true
  if (candidate.generation !== current.generation) {
    return candidate.generation > current.generation
  }
  return candidate.nonce === current.nonce && current.state !== 'conflict'
}

export function createMediaClientRegistry(cacheStorage, origin, memory = new Map()) {
  let mutationQueue = Promise.resolve()
  let revision = 0

  function mutate(operation) {
    const result = mutationQueue.then(operation)
    mutationQueue = result.catch(() => undefined)
    return result
  }

  async function get(clientId) {
    if (!clientId) return null
    for (;;) {
      await mutationQueue
      const readRevision = revision
      const cache = await cacheStorage.open(MEDIA_CONTEXT_CACHE)
      const remembered = memory.get(clientId)
      const record = remembered
        ? { kind: 'client-context', clientId, ...remembered }
        : await readContext(await cache.match(contextRequest(origin, clientId)))
      if (!record || record.clientId !== clientId) return null
      const fence = await authoritativeFence(cache, origin, record.ownerGithubId)
      if (revision !== readRevision) continue
      if (!activeFenceMatches(record, fence)) {
        memory.delete(clientId)
        return null
      }
      const binding = bindingRecord(record)
      memory.set(clientId, binding)
      return binding
    }
  }

  return {
    get,
    async isCurrent(clientId, binding) {
      return sameBinding(await get(clientId), binding)
    },
    async isFenced(binding) {
      if (!isAccountBinding(binding)) return false
      await mutationQueue
      const cache = await cacheStorage.open(MEDIA_CONTEXT_CACHE)
      return fencedFenceMatches(
        binding,
        await authoritativeFence(cache, origin, binding.ownerGithubId),
      )
    },
    async set(clientId, binding) {
      if (!clientId) return false
      revision += 1
      memory.delete(clientId)
      if (!isAccountBinding(binding)) {
        return mutate(async () => {
          const cache = await cacheStorage.open(MEDIA_CONTEXT_CACHE)
          await cache.delete(contextRequest(origin, clientId))
          return false
        })
      }
      return mutate(async () => {
        const cache = await cacheStorage.open(MEDIA_CONTEXT_CACHE)
        const fence = await authoritativeFence(cache, origin, binding.ownerGithubId)
        if (!candidateCanAdvance(binding, fence) || fencedFenceMatches(binding, fence)) {
          await cache.delete(contextRequest(origin, clientId))
          return false
        }
        const storedBinding = bindingRecord(binding)
        await cache.put(
          fenceRequest(origin, binding, 'active'),
          jsonResponse({ kind: 'account-fence', state: 'active', ...storedBinding }),
        )
        await cache.put(
          contextRequest(origin, clientId),
          jsonResponse({ kind: 'client-context', clientId, ...storedBinding }),
        )
        const persisted = await authoritativeFence(cache, origin, binding.ownerGithubId)
        if (!activeFenceMatches(binding, persisted)) {
          await cache.delete(contextRequest(origin, clientId))
          return false
        }
        memory.set(clientId, storedBinding)
        return true
      })
    },
    async fenceAccount(binding) {
      if (!isAccountBinding(binding)) return false
      revision += 1
      for (const [clientId, current] of memory) {
        if (
          current.ownerGithubId === binding.ownerGithubId &&
          (current.generation < binding.generation || sameBinding(current, binding))
        ) {
          memory.delete(clientId)
        }
      }
      return mutate(async () => {
        const cache = await cacheStorage.open(MEDIA_CONTEXT_CACHE)
        const fence = await authoritativeFence(cache, origin, binding.ownerGithubId)
        if (!candidateCanAdvance(binding, fence)) return false
        const storedBinding = bindingRecord(binding)
        await cache.put(
          fenceRequest(origin, binding, 'fenced'),
          jsonResponse({ kind: 'account-fence', state: 'fenced', ...storedBinding }),
        )
        const persisted = await authoritativeFence(cache, origin, binding.ownerGithubId)
        if (!fencedFenceMatches(binding, persisted)) return false
        const keys = (await cache.keys()).filter(isContextRequest)
        await Promise.all(
          keys.map(async request => {
            const record = await readContext(await cache.match(request))
            if (
              record?.ownerGithubId === binding.ownerGithubId &&
              record.generation <= binding.generation
            ) {
              await cache.delete(request)
            }
          }),
        )
        for (const [clientId, current] of memory) {
          if (
            current.ownerGithubId === binding.ownerGithubId &&
            current.generation <= binding.generation
          ) {
            memory.delete(clientId)
          }
        }
        return true
      })
    },
    async prune(activeClientIds) {
      revision += 1
      for (const clientId of memory.keys()) {
        if (!activeClientIds.has(clientId)) memory.delete(clientId)
      }
      return mutate(async () => {
        const cache = await cacheStorage.open(MEDIA_CONTEXT_CACHE)
        const keys = (await cache.keys()).filter(isContextRequest)
        await Promise.all(
          keys.map(async request => {
            const record = await readContext(await cache.match(request))
            if (!record || !activeClientIds.has(record.clientId)) await cache.delete(request)
          }),
        )
      })
    },
  }
}
