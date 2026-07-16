import type { AppRouterClient } from '@better-github-feed/api/routers/index'
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'

import { deleteIndexedDbDatabase } from './indexeddb-delete'

const LEGACY_CACHE_DATABASE = 'keyval-store'

export async function clearPersistedCache() {
  if (!('indexedDB' in window)) return
  await deleteIndexedDbDatabase(window.indexedDB, LEGACY_CACHE_DATABASE)
}

export const link = new RPCLink({
  url: new URL('/api/rpc', window.location.origin).href,
  fetch(url, options) {
    return fetch(url, {
      ...options,
      credentials: 'include',
    })
  },
})

export const client: AppRouterClient = createORPCClient(link)
