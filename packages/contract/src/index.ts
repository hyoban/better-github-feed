import { oc } from '@orpc/contract'
import { z } from 'zod'

// Refresh progress event types for streaming (exported for client use)
export type ActivityError = {
  login: string
  message: string
}

export type RefreshProgressEvent
  = | { type: 'start', total: number }
    | { type: 'success', login: string, index: number, itemCount: number }
    | { type: 'error', login: string, index: number, message: string }
    | { type: 'done', errors: ActivityError[] }

const loginSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^@?[a-z0-9-]+$/i, 'Invalid GitHub username')

export const contract = oc.$route({
  inputStructure: 'detailed',
})

// Shared output schemas
const subscriptionSchema = z.object({
  id: z.string(),
  githubUserLogin: z.string(),
  githubUserId: z.string().nullable(),
  lastRefreshedAt: z.date().nullable(),
  createdAt: z.date(),
})

const subscriptionWithStatsSchema = subscriptionSchema.extend({
  itemCount: z.number(),
  latestEntryAt: z.date().nullable(),
})

const feedItemSchema = z.object({
  id: z.string(),
  actor: z.string(),
  title: z.string(),
  link: z.string().nullable(),
  repo: z.string().nullable(),
  type: z.string(),
  publishedAt: z.string(),
  publishedAtMs: z.number(),
  summary: z.string().nullable(),
  content: z.string().nullable(),
  source: z.string(),
})

// FilterGroup from @fn-sphere/filter has complex branded types that can't be modeled in Zod
// Use z.any() to allow the actual type to pass through without validation issues
const userFilterSchema = z.object({
  id: z.string(),
  name: z.string(),
  filterRule: z.any(),
  createdAt: z.date(),
  updatedAt: z.date(),
})

// Health contract
export const healthContract = {
  check: contract
    .route({ method: 'GET', path: '/health' })
    .output(z.string()),
}

// Subscription contract
export const subscriptionContract = {
  list: contract
    .route({ method: 'GET', path: '/subscription' })
    .output(z.array(subscriptionWithStatsSchema)),
  add: contract
    .route({ method: 'POST', path: '/subscription' })
    .input(z.object({ body: z.object({ login: loginSchema }) }))
    .output(subscriptionSchema),
  remove: contract
    .route({ method: 'DELETE', path: '/subscription/{id}' })
    .input(z.object({ params: z.object({ id: z.string().trim().min(1) }) }))
    .output(z.object({ ok: z.literal(true) })),
  importOpml: contract
    .route({ method: 'POST', path: '/subscription/import-opml' })
    .input(z.object({ body: z.object({ opml: z.string().trim().min(1) }) }))
    .output(z.object({
      total: z.number(),
      added: z.number(),
      skipped: z.number(),
      logins: z.array(z.string()),
    })),
  exportOpml: contract
    .route({ method: 'GET', path: '/subscription/export-opml' })
    .output(z.object({ opml: z.string() })),
}

// Feed contract
export const feedContract = {
  list: contract
    .route({ method: 'GET', path: '/feed' })
    .input(
      z.object({
        query: z
          .object({
            cursor: z.coerce.number().optional(),
            limit: z.coerce.number().min(1).max(100).default(20),
            users: z
              .union([z.string(), z.array(z.string())])
              .transform(v => (Array.isArray(v) ? v : [v]))
              .optional(),
            types: z
              .union([z.string(), z.array(z.string())])
              .transform(v => (Array.isArray(v) ? v : [v]))
              .optional(),
          })
          .optional(),
      }),
    )
    .output(z.object({
      items: z.array(feedItemSchema),
      nextCursor: z.number().nullable(),
      hasMore: z.boolean(),
      types: z.array(z.string()),
      typeCounts: z.record(z.string(), z.number()),
    })),
  // Generator/streaming endpoint - output type inferred from handler
  refresh: contract
    .route({ method: 'POST', path: '/feed/refresh' }),
  refreshOne: contract
    .route({ method: 'POST', path: '/feed/refresh/{login}' })
    .input(z.object({ params: z.object({ login: loginSchema }) }))
    .output(z.object({
      refreshedAt: z.string(),
      itemCount: z.number(),
    })),
  clear: contract
    .route({ method: 'POST', path: '/feed/clear' })
    .output(z.object({ ok: z.literal(true) })),
  cleanup: contract
    .route({ method: 'POST', path: '/feed/cleanup' })
    .input(
      z.object({
        body: z.object({ maxItemsPerUser: z.number().min(1).max(1000).default(200) }).optional(),
      }),
    )
    .output(z.object({ deleted: z.number() })),
}

// Filter contract
export const filterContract = {
  list: contract
    .route({ method: 'GET', path: '/filter' })
    .output(z.array(userFilterSchema)),
  create: contract
    .route({ method: 'POST', path: '/filter' })
    .input(
      z.object({
        body: z.object({
          name: z.string().min(1).max(100),
          filterRule: z.string(),
        }),
      }),
    )
    .output(userFilterSchema),
  update: contract
    .route({ method: 'PATCH', path: '/filter/{id}' })
    .input(
      z.object({
        params: z.object({ id: z.string() }),
        body: z.object({
          name: z.string().min(1).max(100).optional(),
          filterRule: z.string().optional(),
        }),
      }),
    )
    .output(userFilterSchema),
  delete: contract
    .route({ method: 'DELETE', path: '/filter/{id}' })
    .input(z.object({ params: z.object({ id: z.string() }) }))
    .output(z.object({ success: z.literal(true) })),
  getSchema: contract
    .route({ method: 'GET', path: '/filter/schema' })
    .output(z.object({
      schema: z.unknown(),
      filterFnList: z.array(z.object({ name: z.string() })),
      emptyFilterGroup: z.unknown(),
    })),
}

// Private data contract
const privateDataContract = contract
  .route({ method: 'GET', path: '/private-data' })
  .output(z.object({
    message: z.string(),
    user: z.unknown().optional(),
  }))

export const routerContract = {
  health: healthContract,
  subscription: subscriptionContract,
  feed: feedContract,
  filter: filterContract,
  privateData: privateDataContract,
}
