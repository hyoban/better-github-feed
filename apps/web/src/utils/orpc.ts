import type { AppRouterClient } from '@better-github-feed/api/routers/index'
import { env } from '@better-github-feed/env/web'
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import { createTanstackQueryUtils } from '@orpc/tanstack-query'
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister'
import { QueryCache, QueryClient } from '@tanstack/react-query'
import { del, get, set } from 'idb-keyval'
import { toast } from 'sonner'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      gcTime: 1000 * 60 * 60 * 24, // 24 hours
      staleTime: 1000 * 60 * 5, // 5 minutes
    },
  },
  queryCache: new QueryCache({
    onError: (error, query) => {
      toast.error(`Error: ${error.message}`, {
        action: {
          label: 'retry',
          onClick: query.invalidate,
        },
      })
    },
  }),
})

// Use IndexedDB for larger storage capacity (via idb-keyval)
const idbStorage
  = typeof window !== 'undefined'
    ? {
        getItem: async (key: string) => {
          const value = await get<string>(key)
          return value ?? null
        },
        setItem: async (key: string, value: string) => {
          await set(key, value)
        },
        removeItem: async (key: string) => {
          await del(key)
        },
      }
    : undefined

const CACHE_KEY = 'REACT_QUERY_OFFLINE_CACHE'

export const persister = createAsyncStoragePersister({
  storage: idbStorage,
  key: CACHE_KEY,
})

export async function clearPersistedCache() {
  if (idbStorage) {
    await idbStorage.removeItem(CACHE_KEY)
  }
}

export const link = new RPCLink({
  url: `${env.VITE_SERVER_URL}/rpc`,
  fetch(url, options) {
    return fetch(url, {
      ...options,
      credentials: 'include',
    })
  },
})

export const client: AppRouterClient = createORPCClient(link)

export const orpc = createTanstackQueryUtils(client)
