import { filterGroupSchema } from '@better-github-feed/shared'
import type { AppRouterClient } from '@better-github-feed/api/routers/index'
import { ORPCError } from '@orpc/client'

import type {
  CloudReplicaPort,
  UserMutationResult,
  UserStateMutation,
  UserStatePage,
} from './cloud-replica'
import { CloudReplicaError } from './cloud-replica'

type WireFilterReplica = {
  id: string
  name: string
  filterRule: unknown
  version: number
  changedRevision: string
  createdAt: number
  updatedAt: number
  deletedAt: number | null
}

type WireFeedStateReplica = {
  activityClearedAt: number
  version: number
  changedRevision: string
}

type WireUserStatePage = Omit<UserStatePage, 'filters' | 'feedState'> & {
  filters: readonly WireFilterReplica[]
  feedState: WireFeedStateReplica
}

type WirePushResult =
  | {
      viewerGithubId: string
      kind: 'applied' | 'already-applied'
      entityKind: 'filter' | 'feed-state'
      replica: WireFilterReplica | WireFeedStateReplica
    }
  | {
      viewerGithubId: string
      kind: 'conflict'
      entityKind: 'filter' | 'feed-state'
      currentReplica: WireFilterReplica | WireFeedStateReplica | null
    }

type WireMutation =
  | {
      kind: 'filter.put'
      mutationId: string
      attemptId: string
      baseVersion: number
      filter: { id: string; name: string; filterRule: unknown }
    }
  | Extract<UserStateMutation, { kind: 'filter.delete' }>
  | {
      kind: 'feed.clear'
      mutationId: string
      attemptId: string
      baseVersion: number
      candidate: number
      timeAnchor?: string
    }

export type LocalFeedV1OrpcClient = Pick<AppRouterClient, 'localFeedV1'>

function withoutUndefined<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as T
}

function mapFilterReplica(replica: WireFilterReplica) {
  const parsed = filterGroupSchema.safeParse(replica.filterRule)
  return {
    id: replica.id,
    version: replica.version,
    changedRevision: replica.changedRevision,
    deletedAt: replica.deletedAt,
    value: parsed.success
      ? { name: replica.name, isValid: true as const, rule: parsed.data }
      : {
          name: replica.name,
          isValid: false as const,
          invalidLegacyRule: replica.filterRule,
        },
  }
}

function mapFeedStateReplica(replica: WireFeedStateReplica) {
  return {
    version: replica.version,
    changedRevision: replica.changedRevision,
    clearedAt: replica.activityClearedAt,
  }
}

function mapUserStatePage(page: WireUserStatePage): UserStatePage {
  return {
    ...page,
    filters: page.filters.map(mapFilterReplica),
    feedState: mapFeedStateReplica(page.feedState),
  }
}

function mapPushResult(result: WirePushResult): UserMutationResult {
  const replica = result.kind === 'conflict' ? result.currentReplica : result.replica
  const mapped =
    replica === null
      ? {}
      : result.entityKind === 'filter'
        ? { filter: mapFilterReplica(replica as WireFilterReplica) }
        : { feedState: mapFeedStateReplica(replica as WireFeedStateReplica) }
  if (result.kind === 'conflict') {
    return { viewerGithubId: result.viewerGithubId, kind: result.kind, ...mapped }
  }
  return {
    viewerGithubId: result.viewerGithubId,
    kind: result.kind,
    revision: result.replica.changedRevision,
    ...mapped,
  }
}

function finiteRetryAt(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function cloudErrorReason(error: unknown) {
  if (!(error instanceof ORPCError) || error.data === null || typeof error.data !== 'object') {
    return undefined
  }
  const reason = (error.data as { reason?: unknown }).reason
  return typeof reason === 'string' ? reason : undefined
}

export function cloudRetryAt(error: unknown, now = Date.now()) {
  if (!(error instanceof ORPCError) || error.status !== 429) return undefined
  const data = error.data
  const retryAt =
    data !== null && typeof data === 'object'
      ? finiteRetryAt((data as { retryAt?: unknown }).retryAt)
      : undefined
  return retryAt && retryAt > now ? retryAt : now + 60_000
}

function normalizeCloudError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error)
  const retryAt = cloudRetryAt(error)
  if (retryAt !== undefined) throw new CloudReplicaError('RATE_LIMITED', message, retryAt)
  if (cloudErrorReason(error) === 'REAUTH_REQUIRED') {
    throw new CloudReplicaError('REAUTH_REQUIRED', message)
  }
  if (message.includes('SNAPSHOT_EXPIRED')) throw new CloudReplicaError('SNAPSHOT_EXPIRED')
  if (message.includes('RETENTION_CHANGED')) throw new CloudReplicaError('RETENTION_CHANGED')
  if (message.includes('Following snapshot') || message.includes('followingRevision')) {
    throw new CloudReplicaError('SNAPSHOT_EXPIRED', message)
  }
  if (message.includes('not in the active GitHub Following')) {
    throw new CloudReplicaError('SCOPE_NOT_AUTHORIZED', message)
  }
  if (
    message.includes('GitHub account is required') ||
    message.includes('Reconnect your GitHub account') ||
    message.includes('UNAUTHORIZED')
  ) {
    throw new CloudReplicaError('REAUTH_REQUIRED', message)
  }
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    throw new CloudReplicaError('OFFLINE', message)
  }
  throw new CloudReplicaError('UNAVAILABLE', message)
}

async function call<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    return normalizeCloudError(error)
  }
}

export function createOrpcCloudReplicaPort(client: LocalFeedV1OrpcClient): CloudReplicaPort {
  return {
    getManifest: input =>
      call(async () => {
        const result = await client.localFeedV1.getManifest({
          query: withoutUndefined({ etag: input.etag, bookmark: input.bookmark }),
        })
        return result.kind === 'manifest'
          ? {
              ...result,
              manifest: {
                ...result.manifest,
                following: {
                  ...result.manifest.following,
                  reauthRequiredAt: result.manifest.following.reauthRequiredAt ?? null,
                },
              },
            }
          : result
      }),
    getFollowingPage: input =>
      call(() => client.localFeedV1.getFollowingPage({ query: withoutUndefined(input) })),
    getActivityHistoryPage: input =>
      call(() =>
        client.localFeedV1.getActivityHistoryPage({
          query: withoutUndefined({
            ...input,
            actorKeys: input.scopeKind === 'actors' ? [...input.actorKeys] : undefined,
          }),
        }),
      ),
    getActivityDeltaPage: input =>
      call(() =>
        client.localFeedV1.getActivityDeltaPage({
          query: withoutUndefined({
            ...input,
            actorKeys: input.scopeKind === 'actors' ? [...input.actorKeys] : undefined,
          }),
        }),
      ),
    pullUserState: async input =>
      mapUserStatePage(
        (await call(() =>
          client.localFeedV1.pullUserState({ query: withoutUndefined(input) }),
        )) as WireUserStatePage,
      ),
    pushUserMutation: async input => {
      const mutation: WireMutation =
        input.mutation.kind === 'filter.put'
          ? {
              ...input.mutation,
              filter: {
                id: input.mutation.filter.id,
                name: input.mutation.filter.name,
                filterRule: input.mutation.filter.rule,
              },
            }
          : input.mutation.kind === 'feed.clear'
            ? {
                kind: input.mutation.kind,
                mutationId: input.mutation.mutationId,
                attemptId: input.mutation.attemptId,
                baseVersion: input.mutation.baseVersion,
                candidate: input.mutation.candidate ?? 0,
                ...(input.mutation.timeAnchor ? { timeAnchor: input.mutation.timeAnchor } : {}),
              }
            : input.mutation
      return mapPushResult(
        (await call(() =>
          client.localFeedV1.pushUserMutation({ body: mutation }),
        )) as WirePushResult,
      )
    },
  }
}
