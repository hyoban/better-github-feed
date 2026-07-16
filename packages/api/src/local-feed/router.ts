import * as authSchema from '@better-github-feed/db/schema/auth'
import * as githubSchema from '@better-github-feed/db/schema/github'
import { env } from '@better-github-feed/env/server'
import { ORPCError } from '@orpc/server'
import { drizzle } from 'drizzle-orm/d1'

import { protectedProcedure } from '../index'
import {
  FollowingAuthorizationError,
  FollowingSnapshotTooLargeError,
  FollowingSyncInProgressError,
  FollowingUnavailableError,
} from '../following/following-sync'
import { ensureInitialGithubFollowing } from '../routers/subscription'
import {
  ActivityRetentionChangedError,
  ActivityScopeNotAuthorizedError,
  FollowingSnapshotExpiredError,
  LocalFeedAuthorizationError,
  LocalFeedCursorError,
  createLocalFeedSync,
} from './local-feed-sync'
import { manifestSessionConstraint } from './session-consistency'

const schema = { ...authSchema, ...githubSchema }

function createSyncSession(bookmark?: string) {
  const session = env.DB.withSession(bookmark ?? 'first-primary')
  return {
    session,
    sync: createLocalFeedSync({
      // Drizzle only uses prepare() and batch(), which D1 sessions preserve while
      // pinning reads to the requested bookmark. Its driver types have not yet
      // widened from D1Database to D1DatabaseSession.
      database: drizzle(session as unknown as D1Database, { schema }),
      timeAnchorSecret: env.BETTER_AUTH_SECRET,
    }),
  }
}

type LocalFeedSync = ReturnType<typeof createLocalFeedSync>

function createManifestEtag(manifest: Awaited<ReturnType<LocalFeedSync['getManifest']>>) {
  return `"${encodeURIComponent(
    [
      manifest.protocol,
      manifest.serverEpoch,
      manifest.activity.headSeq,
      manifest.activity.retentionGeneration,
      manifest.following.revision ?? 'none',
      manifest.following.reauthRequiredAt ?? 'authorized',
      manifest.userState.revision,
      manifest.userState.epoch,
    ].join(':'),
  )}"`
}

function mapLocalFeedError(error: unknown): never {
  if (error instanceof LocalFeedAuthorizationError) {
    throw new ORPCError('PRECONDITION_FAILED', { message: error.message })
  }
  if (error instanceof FollowingAuthorizationError) {
    throw new ORPCError('PRECONDITION_FAILED', {
      message: error.message,
      data: { reason: 'REAUTH_REQUIRED' },
    })
  }
  if (error instanceof FollowingUnavailableError) {
    if (error.rateLimited) {
      throw new ORPCError('TOO_MANY_REQUESTS', {
        message: error.message,
        data: { retryAt: error.retryAt ?? Date.now() + 60_000 },
      })
    }
    throw new ORPCError(error.retryable ? 'SERVICE_UNAVAILABLE' : 'BAD_GATEWAY', {
      message: error.message,
    })
  }
  if (error instanceof FollowingSnapshotTooLargeError) {
    throw new ORPCError('PAYLOAD_TOO_LARGE', { message: error.message })
  }
  if (error instanceof ActivityScopeNotAuthorizedError) {
    throw new ORPCError('FORBIDDEN', { message: error.message })
  }
  if (error instanceof FollowingSnapshotExpiredError) {
    throw new ORPCError('CONFLICT', { message: 'SNAPSHOT_EXPIRED' })
  }
  if (error instanceof ActivityRetentionChangedError) {
    throw new ORPCError('CONFLICT', { message: 'RETENTION_CHANGED' })
  }
  if (error instanceof LocalFeedCursorError) {
    throw new ORPCError('BAD_REQUEST', { message: error.message })
  }
  throw error
}

function toActivityScope(query: {
  scopeKind: 'following' | 'actors'
  followingRevision?: string
  actorKeys?: string[]
}) {
  if (query.scopeKind === 'following') {
    if (!query.followingRevision) {
      throw new ORPCError('BAD_REQUEST', { message: 'followingRevision is required' })
    }
    return { kind: 'following' as const, followingRevision: query.followingRevision }
  }
  const actorKeys = query.actorKeys
  if (!actorKeys?.[0]) {
    throw new ORPCError('BAD_REQUEST', { message: 'actorKeys is required' })
  }
  return { kind: 'actors' as const, actorKeys: actorKeys as [string, ...string[]] }
}

export const localFeedV1Router = {
  getManifest: protectedProcedure.localFeedV1.getManifest.handler(async ({ context, input }) => {
    try {
      // A browser bookmark only guarantees monotonic reads for that browser.
      // Manifest checks must start on the primary to observe writes from other devices.
      let currentSession = createSyncSession(manifestSessionConstraint(input.query?.bookmark))
      let manifest = await currentSession.sync.getManifest(context.session.user.id)
      if (manifest.following.revision === null || manifest.following.reauthRequiredAt !== null) {
        const isAuthorizationRecovery = manifest.following.reauthRequiredAt !== null
        try {
          await ensureInitialGithubFollowing(context.session.user.id)
          currentSession = createSyncSession()
          manifest = await currentSession.sync.getManifest(context.session.user.id)
        } catch (error) {
          if (error instanceof FollowingSyncInProgressError && isAuthorizationRecovery) {
            throw new FollowingUnavailableError(
              'GitHub Following authorization is still being verified',
            )
          }
          if (!(error instanceof FollowingSyncInProgressError)) {
            throw error
          }
        }
      }
      const etag = createManifestEtag(manifest)
      const bookmark = currentSession.session.getBookmark()
      return input.query?.etag === etag
        ? {
            kind: 'not-modified' as const,
            viewerGithubId: manifest.viewerGithubId,
            etag,
            bookmark,
          }
        : { kind: 'manifest' as const, manifest, etag, bookmark }
    } catch (error) {
      mapLocalFeedError(error)
    }
  }),

  getFollowingPage: protectedProcedure.localFeedV1.getFollowingPage.handler(
    async ({ context, input }) => {
      try {
        const { sync } = createSyncSession(input.query.bookmark)
        return await sync.getFollowingPage(context.session.user.id, input.query)
      } catch (error) {
        mapLocalFeedError(error)
      }
    },
  ),

  getActivityHistoryPage: protectedProcedure.localFeedV1.getActivityHistoryPage.handler(
    async ({ context, input }) => {
      try {
        const { sync } = createSyncSession(input.query.bookmark)
        return await sync.getActivityHistoryPage(context.session.user.id, {
          scope: toActivityScope(input.query),
          cursor: input.query.cursor,
          limit: input.query.limit,
          targetThroughSeq: input.query.targetThroughSeq,
        })
      } catch (error) {
        mapLocalFeedError(error)
      }
    },
  ),

  getActivityDeltaPage: protectedProcedure.localFeedV1.getActivityDeltaPage.handler(
    async ({ context, input }) => {
      try {
        const { sync } = createSyncSession(input.query.bookmark)
        return await sync.getActivityDeltaPage(context.session.user.id, {
          scope: toActivityScope(input.query),
          fromSeq: input.query.fromSeq,
          cursor: input.query.cursor,
          limit: input.query.limit,
          targetThroughSeq: input.query.targetThroughSeq,
        })
      } catch (error) {
        mapLocalFeedError(error)
      }
    },
  ),

  getActivityById: protectedProcedure.localFeedV1.getActivityById.handler(
    async ({ context, input }) => {
      try {
        const { sync } = createSyncSession(input.query?.bookmark)
        return await sync.getActivityById(context.session.user.id, input.params.id)
      } catch (error) {
        mapLocalFeedError(error)
      }
    },
  ),

  pullUserState: protectedProcedure.localFeedV1.pullUserState.handler(
    async ({ context, input }) => {
      try {
        const { sync } = createSyncSession(input.query?.bookmark)
        return await sync.pullUserState(context.session.user.id, input.query)
      } catch (error) {
        mapLocalFeedError(error)
      }
    },
  ),

  pushUserMutation: protectedProcedure.localFeedV1.pushUserMutation.handler(
    async ({ context, input }) => {
      try {
        const { sync } = createSyncSession()
        return await sync.pushUserMutation(context.session.user.id, input.body)
      } catch (error) {
        mapLocalFeedError(error)
      }
    },
  ),
}
