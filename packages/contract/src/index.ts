import { filterGroupSchema } from '@better-github-feed/shared'
import { oc } from '@orpc/contract'
import { z } from 'zod'

// Refresh progress event types for streaming (exported for client use)
export type ActivityError = {
  login: string
  message: string
}

export type RefreshProgressEvent =
  | { type: 'start'; total: number; skipped: number }
  | { type: 'success'; login: string; index: number; itemCount: number }
  | { type: 'error'; login: string; index: number; message: string }
  | { type: 'done'; errors: ActivityError[] }

const loginSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^@?[a-z0-9-]+$/i, 'Invalid GitHub username')

const visibleFeedCursorSchema = z
  .string()
  .max(500)
  .refine(cursor => {
    const separator = cursor.indexOf(':')
    const publishedAtMs = Number(cursor.slice(0, separator))
    const encodedId = cursor.slice(separator + 1)
    if (
      separator < 1 ||
      !Number.isSafeInteger(publishedAtMs) ||
      Math.abs(publishedAtMs) > 8_640_000_000_000_000 ||
      encodedId.length === 0
    ) {
      return false
    }
    try {
      const id = decodeURIComponent(encodedId)
      return id.length > 0 && encodeURIComponent(id) === encodedId
    } catch {
      return false
    }
  }, 'Invalid Visible Feed cursor')

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

const userFilterBaseSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
})
const userFilterSchema = z.discriminatedUnion('isValid', [
  userFilterBaseSchema.extend({
    isValid: z.literal(true),
    filterRule: filterGroupSchema,
  }),
  userFilterBaseSchema.extend({
    isValid: z.literal(false),
    filterRule: z.null(),
  }),
])

// Health contract
export const healthContract = {
  check: contract.route({ method: 'GET', path: '/health' }).output(z.string()),
}

// GitHub following sync contract
export const subscriptionContract = {
  list: contract
    .route({ method: 'GET', path: '/subscription' })
    .output(z.array(subscriptionWithStatsSchema)),
  /** @deprecated Retained temporarily for compatibility with legacy clients during rollout. */
  sync: contract.route({ method: 'POST', path: '/subscription/sync' }).output(
    z.object({
      total: z.number(),
      added: z.number(),
      removed: z.number(),
    }),
  ),
}

// Feed contract
export const feedContract = {
  list: contract
    .route({ method: 'GET', path: '/feed' })
    .input(
      z.object({
        query: z
          .object({
            cursor: visibleFeedCursorSchema.optional(),
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
    .output(
      z.object({
        items: z.array(feedItemSchema),
        nextCursor: z.string().nullable(),
        hasMore: z.boolean(),
        types: z.array(z.string()),
        typeCounts: z.record(z.string(), z.number()),
      }),
    ),
  /** @deprecated Retained temporarily for compatibility with legacy clients during rollout. */
  refresh: contract.route({ method: 'POST', path: '/feed/refresh' }),
  /** @deprecated Retained temporarily for compatibility with legacy clients during rollout. */
  refreshOne: contract
    .route({ method: 'POST', path: '/feed/refresh/{login}' })
    .input(z.object({ params: z.object({ login: loginSchema }) }))
    .output(
      z.discriminatedUnion('skipped', [
        z.object({ skipped: z.literal(true) }),
        z.object({
          skipped: z.literal(false),
          refreshedAt: z.string(),
          itemCount: z.number(),
        }),
      ]),
    ),
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
  list: contract.route({ method: 'GET', path: '/filter' }).output(z.array(userFilterSchema)),
  create: contract
    .route({ method: 'POST', path: '/filter' })
    .input(
      z.object({
        body: z.object({
          name: z.string().min(1).max(100),
          filterRule: filterGroupSchema,
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
          filterRule: filterGroupSchema.optional(),
        }),
      }),
    )
    .output(userFilterSchema),
  delete: contract
    .route({ method: 'DELETE', path: '/filter/{id}' })
    .input(z.object({ params: z.object({ id: z.string() }) }))
    .output(z.object({ success: z.literal(true) })),
}

const decimalSequenceSchema = z
  .string()
  .max(19)
  .regex(/^(0|[1-9]\d*)$/)
const syncCursorSchema = z.string().min(1).max(4000)
const bookmarkSchema = z.string().min(1).max(4000)
const actorKeySchema = z.string().min(1).max(256)
const revisionSchema = z.string().min(1).max(200)
const userStateAfterSeqSchema = syncCursorSchema.refine(
  value => !/^\d+$/.test(value) || decimalSequenceSchema.safeParse(value).success,
  'Invalid User State sequence',
)

const revisionManifestSchema = z.object({
  protocol: z.literal(1),
  serverEpoch: z.string(),
  viewerGithubId: z.string(),
  serverTime: z.number().int(),
  timeAnchor: z.string(),
  activity: z.object({
    headSeq: decimalSequenceSchema,
    retentionGeneration: decimalSequenceSchema,
  }),
  following: z.object({
    revision: revisionSchema.nullable(),
    completedAt: z.number().int().nullable(),
    reauthRequiredAt: z.number().int().nullable().optional(),
  }),
  userState: z.object({
    revision: decimalSequenceSchema,
    epoch: z.string(),
  }),
})

const remoteAtomActivitySchema = z.object({
  id: z.string(),
  source: z.literal('github-atom-v1'),
  actorKey: z.string(),
  actorGithubId: z.string().nullable(),
  actorLogin: z.string(),
  title: z.string(),
  link: z.string().nullable(),
  repo: z.string().nullable(),
  type: z.string(),
  publishedAt: z.string(),
  publishedAtMs: z.number().int(),
  summary: z.string().nullable(),
  content: z.string().nullable(),
})

const activityScopeQuerySchema = z
  .object({
    scopeKind: z.enum(['following', 'actors']),
    followingRevision: revisionSchema.optional(),
    actorKeys: z
      .union([actorKeySchema, z.array(actorKeySchema).min(1).max(250)])
      .transform(value => (Array.isArray(value) ? value : [value]))
      .optional(),
    cursor: syncCursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(250).default(100),
    targetThroughSeq: decimalSequenceSchema.optional(),
    bookmark: bookmarkSchema.optional(),
  })
  .superRefine((query, context) => {
    if (query.scopeKind === 'following' && !query.followingRevision) {
      context.addIssue({ code: 'custom', message: 'followingRevision is required' })
    }
    if (query.scopeKind === 'actors' && (!query.actorKeys || query.actorKeys.length === 0)) {
      context.addIssue({ code: 'custom', message: 'actorKeys is required' })
    }
  })

const filterReplicaSchema = z.object({
  id: z.string(),
  name: z.string(),
  filterRule: z.unknown(),
  version: z.number().int().nonnegative(),
  changedRevision: decimalSequenceSchema,
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  deletedAt: z.number().int().nullable(),
})

const feedStateReplicaSchema = z.object({
  activityClearedAt: z.number().int(),
  version: z.number().int().nonnegative(),
  changedRevision: decimalSequenceSchema,
})

export const userFilterMutationValueSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(100),
  filterRule: filterGroupSchema,
})

const userMutationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('filter.put'),
    mutationId: z.string().min(1).max(200),
    attemptId: z.string().min(1).max(200),
    baseVersion: z.number().int().nonnegative(),
    filter: userFilterMutationValueSchema,
  }),
  z.object({
    kind: z.literal('filter.delete'),
    mutationId: z.string().min(1).max(200),
    attemptId: z.string().min(1).max(200),
    baseVersion: z.number().int().nonnegative(),
    id: z.string().min(1).max(200),
  }),
  z.object({
    kind: z.literal('feed.clear'),
    mutationId: z.string().min(1).max(200),
    attemptId: z.string().min(1).max(200),
    baseVersion: z.number().int().nonnegative(),
    candidate: z.number().int(),
    timeAnchor: z.string().max(1000).optional(),
  }),
])

export const localFeedV1Contract = {
  getManifest: contract
    .route({ method: 'GET', path: '/local-feed/v1/manifest' })
    .input(
      z.object({
        query: z
          .object({ etag: z.string().max(1000).optional(), bookmark: bookmarkSchema.optional() })
          .optional(),
      }),
    )
    .output(
      z.discriminatedUnion('kind', [
        z.object({
          kind: z.literal('manifest'),
          manifest: revisionManifestSchema,
          etag: z.string(),
          bookmark: z.string().nullable(),
        }),
        z.object({
          kind: z.literal('not-modified'),
          viewerGithubId: z.string(),
          etag: z.string(),
          bookmark: z.string().nullable(),
        }),
      ]),
    ),
  getFollowingPage: contract
    .route({ method: 'GET', path: '/local-feed/v1/following' })
    .input(
      z.object({
        query: z.object({
          revision: revisionSchema,
          cursor: syncCursorSchema.optional(),
          limit: z.coerce.number().int().min(1).max(250).default(100),
          bookmark: bookmarkSchema.optional(),
        }),
      }),
    )
    .output(
      z.object({
        viewerGithubId: z.string(),
        revision: revisionSchema,
        items: z.array(
          z.object({
            actorKey: z.string(),
            githubId: z.string(),
            login: z.string(),
            legacyActorKeys: z.array(z.string()),
          }),
        ),
        nextCursor: syncCursorSchema.nullable(),
      }),
    ),
  getActivityHistoryPage: contract
    .route({ method: 'GET', path: '/local-feed/v1/activity/history' })
    .input(z.object({ query: activityScopeQuerySchema }))
    .output(
      z.object({
        viewerGithubId: z.string(),
        scopeKey: z.string(),
        throughSeq: decimalSequenceSchema,
        retentionFingerprint: z.string(),
        items: z.array(remoteAtomActivitySchema),
        nextCursor: syncCursorSchema.nullable(),
        remoteWindowEnd: z.boolean(),
      }),
    ),
  getActivityDeltaPage: contract
    .route({ method: 'GET', path: '/local-feed/v1/activity/delta' })
    .input(
      z.object({
        query: activityScopeQuerySchema.and(z.object({ fromSeq: decimalSequenceSchema })),
      }),
    )
    .output(
      z.object({
        viewerGithubId: z.string(),
        scopeKey: z.string(),
        throughSeq: decimalSequenceSchema,
        retentionFingerprint: z.string(),
        gap: z.object({ compactedThroughSeq: decimalSequenceSchema }).nullable(),
        items: z.array(remoteAtomActivitySchema),
        nextCursor: syncCursorSchema.nullable(),
      }),
    ),
  getActivityById: contract
    .route({ method: 'GET', path: '/local-feed/v1/activity/{id}' })
    .input(
      z.object({
        params: z.object({ id: z.string().min(1).max(1000) }),
        query: z.object({ bookmark: bookmarkSchema.optional() }).optional(),
      }),
    )
    .output(
      z.object({
        viewerGithubId: z.string(),
        result: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('found'), activity: remoteAtomActivitySchema }),
          z.object({ kind: z.literal('not-authorized') }),
          z.object({ kind: z.literal('cloud-miss') }),
        ]),
      }),
    ),
  pullUserState: contract
    .route({ method: 'GET', path: '/local-feed/v1/user-state' })
    .input(
      z.object({
        query: z
          .object({
            afterSeq: userStateAfterSeqSchema.optional(),
            epoch: z.string().min(1).max(500).optional(),
            limit: z.coerce.number().int().min(1).max(250).default(100),
            bookmark: bookmarkSchema.optional(),
          })
          .optional(),
      }),
    )
    .output(
      z.object({
        viewerGithubId: z.string(),
        mode: z.enum(['delta', 'snapshot']),
        revision: decimalSequenceSchema,
        epoch: z.string(),
        compactedThroughSeq: decimalSequenceSchema,
        filters: z.array(filterReplicaSchema),
        feedState: feedStateReplicaSchema,
        nextCursor: syncCursorSchema.nullable(),
      }),
    ),
  pushUserMutation: contract
    .route({ method: 'POST', path: '/local-feed/v1/user-state/mutation' })
    .input(z.object({ body: userMutationSchema }))
    .output(
      z.union([
        z.object({
          viewerGithubId: z.string(),
          kind: z.enum(['applied', 'already-applied']),
          entityKind: z.enum(['filter', 'feed-state']),
          replica: z.union([filterReplicaSchema, feedStateReplicaSchema]),
        }),
        z.object({
          viewerGithubId: z.string(),
          kind: z.literal('conflict'),
          entityKind: z.enum(['filter', 'feed-state']),
          currentReplica: z.union([filterReplicaSchema, feedStateReplicaSchema]).nullable(),
        }),
      ]),
    ),
}

// Private data contract
const privateDataContract = contract.route({ method: 'GET', path: '/private-data' }).output(
  z.object({
    message: z.string(),
    user: z.unknown().optional(),
  }),
)

export const routerContract = {
  health: healthContract,
  subscription: subscriptionContract,
  feed: feedContract,
  filter: filterContract,
  localFeedV1: localFeedV1Contract,
  privateData: privateDataContract,
}
