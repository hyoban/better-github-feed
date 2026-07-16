import Dexie from 'dexie'

import type { AccountGeneration, AccountGenerationPort } from './account-generation'
import { normalizeActivityProjectionId } from './activity-id'
import { CloudReplicaError } from './cloud-replica'
import type {
  ActivityDeltaPage,
  ActivityHistoryPage,
  ActivitySanitizerPort,
  CloudReplicaPort,
  ReplicaScope,
  RevisionManifest,
} from './cloud-replica'
import { incrementLocalRevision, readLocalRevision } from './database'
import type { FollowingAdditionRow, LocalFeedDatabase, SyncLaneRow, SyncStateRow } from './database'
import {
  completeFollowingTransition,
  deriveFollowingTransitionCoverage,
} from './following-transition'
import type { FollowingTransitionPlan } from './following-transition'
import { activityScopeKey } from './projections'
import {
  commitDeltaPage,
  commitHistoryPage,
  compareDecimalSequence,
  finalizeFollowingSnapshot,
  markActivityGap,
  stageFollowingPage,
} from './replica-writes'
import { assertTransactionLeadership } from './tab-coordinator'
import type { LeadershipFence, TabAnnouncement, TabCoordinatorPort } from './tab-coordinator'
import type { SyncLifecyclePort } from './sync-lifecycle'
import { isStorageQuotaError } from './storage-errors'
import type { LocalSyncStatus, Projection } from './types'
import { applyMutationResult, applyUserStatePages, prepareNextMutation } from './user-state'

type ActivitySyncPlan = {
  localScopeKey: string
  scope: ReplicaScope
  targetThroughSeq: string
}

class ForegroundSyncPaused extends Error {}

class RateLimitSyncPaused extends Error {}

export function followingManifestRequiresReauthentication(manifest: RevisionManifest) {
  return manifest.following.reauthRequiredAt != null
}

export function followingActivitySyncPlan(manifest: {
  activity: Pick<RevisionManifest['activity'], 'headSeq'>
  following: Pick<RevisionManifest['following'], 'revision'>
}) {
  const revision = manifest.following.revision
  if (!revision) return null
  return {
    localScopeKey: activityScopeKey('following', revision),
    scope: { scopeKind: 'following' as const, followingRevision: revision },
    targetThroughSeq: manifest.activity.headSeq,
  }
}

export function completeSyncPageInput<T extends object>(input: T): T & { limit: 250 } {
  return { ...input, limit: 250 }
}

export function syncProgressForCompletedCheckpoints(completed: number) {
  if (!Number.isSafeInteger(completed) || completed < 0) {
    throw new RangeError('Invalid completed sync checkpoint count')
  }
  return Math.min(99, Math.max(1, Math.round(99 - 98 * Math.exp(-completed / 20))))
}

export async function settleWithin(promise: Promise<unknown>, timeoutMs: number) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new RangeError('Invalid settle timeout')
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      new Promise<false>(resolve => {
        timer = setTimeout(() => resolve(false), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export function chunkActorKeys(
  actorKeys: readonly string[],
  maximum = 250,
): (readonly [string, ...string[]])[] {
  if (!Number.isSafeInteger(maximum) || maximum < 1)
    throw new RangeError('Invalid actor chunk size')
  const chunks: (readonly [string, ...string[]])[] = []
  for (let index = 0; index < actorKeys.length; index += maximum) {
    const chunk = actorKeys.slice(index, index + maximum)
    if (chunk[0]) chunks.push(chunk as [string, ...string[]])
  }
  return chunks
}

export function computeRateLimitRetryAt(
  serverRetryAt: number | undefined,
  now: number,
  random: () => number,
) {
  const base = Math.max(serverRetryAt ?? now + 60_000, now + 1_000)
  return base + Math.floor(Math.max(0, Math.min(0.999_999, random())) * 5_000)
}

export function computeUnavailableRetryAt(attempt: number, now: number, random: () => number) {
  const exponential = Math.min(5 * 60_000, 1_000 * 2 ** Math.max(0, Math.min(8, attempt)))
  const jitter = Math.floor(exponential * 0.2 * Math.max(0, Math.min(0.999_999, random())))
  return now + exponential + jitter
}

const INVALID_SELECTION_KEY = 'better-github-feed:invalid-selection'

function canonicalValues(values: readonly string[], maximum: number) {
  const bounded = new Set<string>()
  for (const value of values) {
    bounded.add(value.length > 0 && value.length <= 256 ? value : INVALID_SELECTION_KEY)
    if (bounded.size >= maximum) break
  }
  if (bounded.size === 0) bounded.add(INVALID_SELECTION_KEY)
  return [...bounded].sort()
}

export function canonicalizeProjection<P extends Projection>(projection: P): P {
  if (projection.kind === 'visible-feed') {
    return {
      ...projection,
      view: {
        actors:
          projection.view.actors === 'following'
            ? 'following'
            : canonicalValues(projection.view.actors, 250),
        types: projection.view.types === 'all' ? 'all' : canonicalValues(projection.view.types, 64),
      },
    } as P
  }
  if (projection.kind === 'statistics') {
    return {
      ...projection,
      actors:
        projection.actors === 'following' ? 'following' : canonicalValues(projection.actors, 250),
    } as P
  }
  if (projection.kind === 'activity') {
    return { ...projection, id: normalizeActivityProjectionId(projection.id) } as P
  }
  return projection
}

export function canonicalProjectionKey(projection: Projection) {
  return JSON.stringify(canonicalizeProjection(projection))
}

export function shouldRunForegroundSync(visible: boolean) {
  return visible
}

export function didServerEpochChange(previous: string | undefined, next: string) {
  return previous !== undefined && previous !== next
}

export function canPullActivityDelta(
  lane: Pick<SyncLaneRow, 'stableThroughSeq' | 'checkpointAfterHistory'> | null | undefined,
) {
  return Boolean(lane?.stableThroughSeq && !lane.checkpointAfterHistory)
}

function isAccountMismatch(error: unknown) {
  return error instanceof Error && error.message.includes('viewer mismatch')
}

export class IncrementalSync {
  readonly #createId: () => string
  readonly #now: () => number
  readonly #random: () => number
  readonly #onAccountAttention:
    | ((issue: 'reauth-required' | 'account-mismatch') => void)
    | undefined
  #closed = false
  #haltedForAccountAttention = false
  #requested = false
  #running: Promise<void> | null = null
  #unsubscribeLifecycle: (() => void) | null = null
  #unsubscribeTabs: (() => void) | null = null
  #followingSnapshotRecoveryRevision: string | null = null
  #retryAt: number | null = null
  #retryTimer: ReturnType<typeof setTimeout> | null = null
  #unavailableAttempts = 0
  #completedSyncCheckpoints = 0

  constructor(
    private readonly database: LocalFeedDatabase,
    private readonly owner: AccountGeneration,
    private readonly generations: AccountGenerationPort,
    private readonly cloud: CloudReplicaPort | undefined,
    private readonly sanitizer: ActivitySanitizerPort | undefined,
    private readonly tabs: TabCoordinatorPort,
    private readonly lifecycle: SyncLifecyclePort,
    private readonly onLocalChange: (scope?: 'data' | 'status') => Promise<void>,
    options?: {
      createId?: () => string
      now?: () => number
      random?: () => number
      onAccountAttention?: (issue: 'reauth-required' | 'account-mismatch') => void
    },
  ) {
    if (cloud && !sanitizer) {
      throw new Error('Cloud Activity ingress requires an ActivitySanitizerPort')
    }
    this.#createId = options?.createId ?? (() => crypto.randomUUID())
    this.#now = options?.now ?? Date.now
    this.#random = options?.random ?? Math.random
    this.#onAccountAttention = options?.onAccountAttention
  }

  start() {
    this.#unsubscribeLifecycle = this.lifecycle.subscribe(() => this.requestSync())
    this.#unsubscribeTabs = this.tabs.subscribe(event => this.onTabAnnouncement(event))
    this.requestSync()
  }

  requestSync() {
    if (this.#closed || this.#haltedForAccountAttention) return
    this.#requested = true
    if (!this.#running) {
      this.#running = Promise.resolve()
        .then(() => this.drain())
        .catch(() => undefined)
        .finally(() => {
          this.#running = null
          if (this.#requested) this.requestSync()
        })
    }
  }

  async close() {
    this.#closed = true
    this.#requested = false
    this.#unsubscribeLifecycle?.()
    this.#unsubscribeTabs?.()
    if (this.#retryTimer) clearTimeout(this.#retryTimer)
    this.#retryTimer = null
    if (this.#running) await settleWithin(this.#running, 2_000)
  }

  private onTabAnnouncement(event: TabAnnouncement) {
    if (
      event.kind === 'account-generation' &&
      (event.generation !== this.owner.generation || event.nonce !== this.owner.nonce)
    ) {
      this.#closed = true
      this.#requested = false
      this.#unsubscribeLifecycle?.()
      return
    }
    if (event.kind === 'local-revision') {
      if (event.requestsSync) this.requestSync()
      return
    }
    if (event.kind === 'leadership-retry') {
      this.requestSync()
    }
  }

  private async drain() {
    while (this.#requested && !this.#closed && !this.#haltedForAccountAttention) {
      this.#requested = false
      // oxlint-disable-next-line react-doctor/async-await-in-loop -- sync cycles share checkpoints and must drain in order
      await this.tabs.runAsLeader(fence => this.syncCycle(fence))
    }
  }

  private async assertFence(fence: LeadershipFence) {
    if (!(await fence.isCurrent()) || !(await this.generations.isCurrent(this.owner))) {
      throw new Error('Incremental Sync lost its fencing token')
    }
  }

  private async beforeCloudRequest(fence: LeadershipFence) {
    await this.assertFence(fence)
    if (this.#closed || !this.lifecycle.isVisible()) throw new ForegroundSyncPaused()
    if (!this.lifecycle.isOnline()) throw new CloudReplicaError('OFFLINE')
    if (this.#retryAt !== null && this.#now() < this.#retryAt) {
      throw new RateLimitSyncPaused()
    }
  }

  private scheduleRetry(retryAt: number) {
    if (this.#closed) return
    if (this.#retryTimer) clearTimeout(this.#retryTimer)
    const delay = Math.max(0, Math.min(2_147_483_647, retryAt - this.#now()))
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null
      if (!this.#closed && this.lifecycle.isVisible() && this.lifecycle.isOnline()) {
        this.requestSync()
      }
    }, delay)
  }

  private async restoreRetryDeadline() {
    const state = await this.database.syncState.get('status')
    const retryAt =
      state?.retryAt ?? (state?.status?.kind === 'degraded' ? state.status.retryAt : undefined)
    this.#retryAt = Math.max(this.#retryAt ?? 0, retryAt ?? 0) || null
    if (this.#retryAt !== null && this.#retryAt <= this.#now()) this.#retryAt = null
    return state?.status
  }

  private async syncCycle(fence: LeadershipFence) {
    fence.accountProof = {
      ownerGithubId: this.owner.ownerGithubId,
      generation: this.owner.generation,
      nonce: this.owner.nonce,
    }
    if (!shouldRunForegroundSync(this.lifecycle.isVisible())) return
    if (!this.cloud || !this.lifecycle.isOnline()) {
      await this.setStatus(
        {
          kind: 'offline',
          pendingUserOperations: await this.database.outbox.count(),
        },
        fence,
      )
      return
    }
    if (
      this.database.volatileSyncStatus?.kind === 'attention' &&
      this.database.volatileSyncStatus.issue === 'storage-full'
    ) {
      return
    }

    const restoredStatus = await this.restoreRetryDeadline()
    if (this.#retryAt !== null) {
      this.scheduleRetry(this.#retryAt)
      if (restoredStatus?.kind !== 'degraded' || restoredStatus.retryAt !== this.#retryAt) {
        await this.setStatus(
          {
            kind: 'degraded',
            issue: 'cloud-unavailable',
            retryAt: this.#retryAt,
            pendingUserOperations: await this.database.outbox.count(),
          },
          fence,
        )
      }
      return
    }

    try {
      this.#completedSyncCheckpoints = 0
      await this.setWorking('control', fence)
      const control = await this.database.syncState.get('control')
      await this.beforeCloudRequest(fence)
      const manifestResult = await this.cloud.getManifest({
        ...(control?.manifestEtag ? { etag: control.manifestEtag } : {}),
        ...(control?.bookmark ? { bookmark: control.bookmark } : {}),
      })
      await this.assertFence(fence)

      let manifest: RevisionManifest | null = null
      const bookmark = manifestResult.bookmark ?? control?.bookmark
      if (manifestResult.kind === 'manifest') {
        manifest = manifestResult.manifest
        this.assertViewer(manifest.viewerGithubId)
        const resetRevision = await this.saveManifest(
          manifest,
          manifestResult.etag,
          bookmark,
          fence,
        )
        if (resetRevision !== null) await this.changed(resetRevision)
      } else {
        this.assertViewer(manifestResult.viewerGithubId)
        await this.touchManifest(manifestResult.etag, bookmark, fence)
        manifest = this.cachedManifest(control)
      }
      await this.advanceWorkingProgress('control', fence)

      if (manifest) {
        if (followingManifestRequiresReauthentication(manifest)) {
          throw new CloudReplicaError(
            'REAUTH_REQUIRED',
            'Reconnect your GitHub account before syncing follows',
          )
        }
        try {
          const transition = await this.syncFollowing(manifest, bookmark, fence)
          if (transition) {
            await this.syncFollowingTransition(transition, bookmark, fence)
            if (transition.newRevision !== manifest.following.revision) this.#requested = true
          }
          this.#followingSnapshotRecoveryRevision = null
        } catch (error) {
          if (!(error instanceof CloudReplicaError) || error.code !== 'SNAPSHOT_EXPIRED') {
            throw error
          }
          const retryImmediately =
            this.#followingSnapshotRecoveryRevision !== manifest.following.revision
          this.#followingSnapshotRecoveryRevision = manifest.following.revision
          await this.resetExpiredFollowingSnapshot(fence)
          await this.setQuiet(fence)
          if (retryImmediately) this.#requested = true
          return
        }
        await this.syncUserState(manifest, bookmark, fence)
      }

      await this.flushOutbox(bookmark, fence)
      const activityPlan = manifest ? followingActivitySyncPlan(manifest) : null
      if (activityPlan) {
        await this.pullCompleteHistory(activityPlan, bookmark, fence)
      }
      this.#retryAt = null
      this.#unavailableAttempts = 0
      if (this.#retryTimer) clearTimeout(this.#retryTimer)
      this.#retryTimer = null
      await this.setStatus(
        {
          kind: 'quiet',
          pendingUserOperations: await this.database.outbox.count(),
          lastCloudContactAt: this.#now(),
        },
        fence,
      )
    } catch (error) {
      if (this.#closed) return
      if (!(await fence.isCurrent()) || !(await this.generations.isCurrent(this.owner))) return
      if (error instanceof ForegroundSyncPaused) {
        await this.setQuiet(fence)
        return
      }
      if (error instanceof RateLimitSyncPaused) {
        await this.setStatus(
          {
            kind: 'degraded',
            issue: 'cloud-unavailable',
            ...(this.#retryAt !== null ? { retryAt: this.#retryAt } : {}),
            pendingUserOperations: await this.database.outbox.count(),
          },
          fence,
        )
        return
      }
      if (isAccountMismatch(error)) {
        this.#haltedForAccountAttention = true
        this.#requested = false
        await this.setStatus(
          {
            kind: 'attention',
            issue: 'account-mismatch',
            pendingUserOperations: await this.database.outbox.count(),
          },
          fence,
        )
        this.#onAccountAttention?.('account-mismatch')
      } else if (error instanceof CloudReplicaError && error.code === 'REAUTH_REQUIRED') {
        this.#haltedForAccountAttention = true
        this.#requested = false
        await this.setStatus(
          {
            kind: 'attention',
            issue: 'reauth-required',
            pendingUserOperations: await this.database.outbox.count(),
          },
          fence,
        )
        this.#onAccountAttention?.('reauth-required')
      } else if (error instanceof CloudReplicaError && error.code === 'RATE_LIMITED') {
        const retryAt = computeRateLimitRetryAt(error.retryAt, this.#now(), this.#random)
        this.#retryAt = retryAt
        this.scheduleRetry(retryAt)
        await this.setStatus(
          {
            kind: 'degraded',
            issue: 'cloud-unavailable',
            retryAt,
            pendingUserOperations: await this.database.outbox.count(),
          },
          fence,
        )
      } else if (
        (error instanceof CloudReplicaError && error.code === 'OFFLINE') ||
        !this.lifecycle.isOnline()
      ) {
        await this.setStatus(
          {
            kind: 'offline',
            pendingUserOperations: await this.database.outbox.count(),
          },
          fence,
        )
      } else if (isStorageQuotaError(error)) {
        await this.setStatus(
          {
            kind: 'attention',
            issue: 'storage-full',
            pendingUserOperations: await this.database.outbox.count(),
          },
          fence,
        )
      } else {
        const retryAt = computeUnavailableRetryAt(
          this.#unavailableAttempts,
          this.#now(),
          this.#random,
        )
        this.#unavailableAttempts += 1
        this.#retryAt = retryAt
        this.scheduleRetry(retryAt)
        await this.setStatus(
          {
            kind: 'degraded',
            issue: 'cloud-unavailable',
            retryAt,
            pendingUserOperations: await this.database.outbox.count(),
          },
          fence,
        )
      }
    }
  }

  private assertViewer(viewerGithubId: string) {
    if (viewerGithubId !== this.owner.ownerGithubId) {
      throw new Error('Cloud replica viewer mismatch')
    }
  }

  private async saveManifest(
    manifest: RevisionManifest,
    etag: string,
    bookmark: string | null | undefined,
    fence: LeadershipFence,
  ) {
    return this.database.transaction(
      'rw',
      [
        this.database.meta,
        this.database.followingMembers,
        this.database.followingMemberships,
        this.database.followingAdditions,
        this.database.followingState,
        this.database.syncLanes,
        this.database.coverage,
        this.database.syncState,
        this.database.syncLease,
      ],
      async () => {
        await assertTransactionLeadership(this.database, fence)
        const previous = await this.database.syncState.get('control')
        const epochChanged = didServerEpochChange(
          previous?.manifestServerEpoch,
          manifest.serverEpoch,
        )
        let localRevision: number | null = null
        if (epochChanged) {
          await Promise.all([
            this.database.followingMembers.clear(),
            this.database.followingMemberships.clear(),
            this.database.followingAdditions.clear(),
            this.database.syncLanes.clear(),
            this.database.coverage.clear(),
            this.database.syncState.where('key').startsWith('activity:').delete(),
          ])
          await this.database.followingState.put({
            key: 'active',
            activeRevision: null,
            stagingRevision: null,
            stagingCursor: null,
            stagingComplete: false,
            stagingFinalizeCursorActorKey: null,
            stagingMembershipDigest: null,
            stagingMembershipCount: 0,
            pendingTransition: null,
            membershipSignature: null,
          })
          localRevision = await incrementLocalRevision(this.database)
        }
        await this.database.syncState.put({
          key: 'control',
          manifestEtag: etag,
          ...(bookmark ? { bookmark } : {}),
          lastCloudContactAt: this.#now(),
          manifestServerTime: manifest.serverTime,
          manifestTimeAnchor: manifest.timeAnchor,
          manifestReceivedAt: this.#now(),
          manifestServerEpoch: manifest.serverEpoch,
          manifestActivityHeadSeq: manifest.activity.headSeq,
          manifestActivityRetentionGeneration: manifest.activity.retentionGeneration,
          manifestFollowingRevision: manifest.following.revision,
          manifestFollowingCompletedAt: manifest.following.completedAt,
          manifestFollowingReauthRequiredAt: manifest.following.reauthRequiredAt,
          manifestUserStateRevision: manifest.userState.revision,
          manifestUserStateEpoch: manifest.userState.epoch,
        })
        return localRevision
      },
    )
  }

  private cachedManifest(control: SyncStateRow | undefined): RevisionManifest | null {
    if (
      !control?.manifestServerEpoch ||
      !control.manifestActivityHeadSeq ||
      !control.manifestActivityRetentionGeneration ||
      !control.manifestUserStateRevision ||
      !control.manifestUserStateEpoch ||
      control.manifestServerTime === undefined ||
      !control.manifestTimeAnchor
    ) {
      return null
    }
    return {
      protocol: 1,
      serverEpoch: control.manifestServerEpoch,
      viewerGithubId: this.owner.ownerGithubId,
      serverTime: control.manifestServerTime,
      timeAnchor: control.manifestTimeAnchor,
      activity: {
        headSeq: control.manifestActivityHeadSeq,
        retentionGeneration: control.manifestActivityRetentionGeneration,
      },
      following: {
        revision: control.manifestFollowingRevision ?? null,
        completedAt: control.manifestFollowingCompletedAt ?? null,
        reauthRequiredAt: control.manifestFollowingReauthRequiredAt ?? null,
      },
      userState: {
        revision: control.manifestUserStateRevision,
        epoch: control.manifestUserStateEpoch,
      },
    }
  }

  private async touchManifest(
    etag: string,
    bookmark: string | null | undefined,
    fence: LeadershipFence,
  ) {
    await this.database.transaction(
      'rw',
      this.database.meta,
      this.database.syncState,
      this.database.syncLease,
      async () => {
        await assertTransactionLeadership(this.database, fence)
        const control = await this.database.syncState.get('control')
        await this.database.syncState.put({
          ...control,
          key: 'control',
          manifestEtag: etag,
          ...(bookmark ? { bookmark } : {}),
          lastCloudContactAt: this.#now(),
        })
      },
    )
  }

  private async resetExpiredFollowingSnapshot(fence: LeadershipFence) {
    await this.assertFence(fence)
    const revision = await this.database.transaction(
      'rw',
      [
        this.database.meta,
        this.database.followingMembers,
        this.database.followingMemberships,
        this.database.followingAdditions,
        this.database.followingState,
        this.database.syncState,
        this.database.syncLease,
      ],
      async () => {
        await assertTransactionLeadership(this.database, fence)
        const state = await this.database.followingState.get('active')
        let activeSnapshotChanged = false
        if (state?.pendingTransition) {
          await Promise.all([
            this.database.followingMembers
              .where('snapshotRevision')
              .equals(state.pendingTransition.newRevision)
              .delete(),
            this.database.followingMemberships
              .where('snapshotRevision')
              .equals(state.pendingTransition.newRevision)
              .delete(),
            this.database.followingAdditions
              .where('snapshotRevision')
              .equals(state.pendingTransition.newRevision)
              .delete(),
          ])
          await this.database.followingState.put({
            ...state,
            activeRevision: state.pendingTransition.oldRevision,
            stagingRevision: null,
            stagingCursor: null,
            stagingComplete: false,
            stagingFinalizeCursorActorKey: null,
            stagingMembershipDigest: null,
            stagingMembershipCount: 0,
            pendingTransition: null,
            membershipSignature: state.pendingTransition.oldMembershipSignature ?? null,
          })
          activeSnapshotChanged = true
        } else if (state?.stagingRevision) {
          await Promise.all([
            this.database.followingMembers
              .where('snapshotRevision')
              .equals(state.stagingRevision)
              .delete(),
            this.database.followingMemberships
              .where('snapshotRevision')
              .equals(state.stagingRevision)
              .delete(),
            this.database.followingAdditions
              .where('snapshotRevision')
              .equals(state.stagingRevision)
              .delete(),
          ])
          await this.database.followingState.put({
            ...state,
            stagingRevision: null,
            stagingCursor: null,
            stagingComplete: false,
            stagingFinalizeCursorActorKey: null,
            stagingMembershipDigest: null,
            stagingMembershipCount: 0,
          })
        }
        const control = await this.database.syncState.get('control')
        if (control) {
          const next = { ...control }
          delete next.manifestEtag
          delete next.bookmark
          await this.database.syncState.put(next)
        }
        return activeSnapshotChanged ? incrementLocalRevision(this.database) : null
      },
    )
    await this.assertFence(fence)
    if (revision !== null) await this.changed(revision)
  }

  private async syncFollowing(
    manifest: RevisionManifest,
    bookmark: string | null | undefined,
    fence: LeadershipFence,
  ) {
    if (!manifest.following.revision) return null
    let state = await this.database.followingState.get('active')
    if (state?.pendingTransition) return state.pendingTransition
    if (state?.activeRevision === manifest.following.revision) return null
    await this.setWorking('following', fence)

    if (state?.stagingRevision && state.stagingRevision !== manifest.following.revision) {
      await this.assertFence(fence)
      await this.database.transaction(
        'rw',
        [
          this.database.meta,
          this.database.followingMembers,
          this.database.followingMemberships,
          this.database.followingAdditions,
          this.database.followingState,
          this.database.syncLease,
        ],
        async () => {
          await assertTransactionLeadership(this.database, fence)
          await Promise.all([
            this.database.followingMembers
              .where('snapshotRevision')
              .equals(state!.stagingRevision!)
              .delete(),
            this.database.followingMemberships
              .where('snapshotRevision')
              .equals(state!.stagingRevision!)
              .delete(),
            this.database.followingAdditions
              .where('snapshotRevision')
              .equals(state!.stagingRevision!)
              .delete(),
          ])
          state = {
            ...state!,
            stagingRevision: null,
            stagingCursor: null,
            stagingComplete: false,
            stagingFinalizeCursorActorKey: null,
            stagingMembershipDigest: null,
            stagingMembershipCount: 0,
          }
          await this.database.followingState.put(state!)
        },
      )
    }

    state = await this.database.followingState.get('active')
    if (state?.stagingRevision === manifest.following.revision && state.stagingComplete) {
      return this.finalizeFollowing(manifest, fence)
    }

    let cursor = state?.stagingRevision === manifest.following.revision ? state.stagingCursor : null
    for (let pageCount = 0; pageCount < 1000; pageCount += 1) {
      await this.beforeCloudRequest(fence)
      const page = await this.cloud!.getFollowingPage(
        completeSyncPageInput({
          revision: manifest.following.revision,
          ...(cursor ? { cursor } : {}),
          ...(bookmark ? { bookmark } : {}),
        }),
      )
      await this.assertFence(fence)
      if (page.revision !== manifest.following.revision) {
        throw new Error('Cloud Following revision mismatch')
      }
      await stageFollowingPage({
        database: this.database,
        ownerGithubId: this.owner.ownerGithubId,
        page,
        expectedCursor: cursor,
        now: this.#now(),
        fence,
      })
      await this.assertFence(fence)
      cursor = page.nextCursor
      await this.advanceWorkingProgress('following', fence)
      if (!cursor) return this.finalizeFollowing(manifest, fence)
    }
    throw new Error('Following snapshot exceeded the page safety limit')
  }

  private async finalizeFollowing(manifest: RevisionManifest, fence: LeadershipFence) {
    for (let batchCount = 0; batchCount < 10_000; batchCount += 1) {
      const result = await finalizeFollowingSnapshot({
        database: this.database,
        targetThroughSeq: manifest.activity.headSeq,
        fence,
      })
      await this.assertFence(fence)
      if (result.localRevision !== null) await this.changed(result.localRevision)
      if (result.done) {
        return (await this.database.followingState.get('active'))?.pendingTransition ?? null
      }
    }
    throw new Error('Following snapshot finalization exceeded the batch safety limit')
  }

  private async syncFollowingTransition(
    plan: FollowingTransitionPlan,
    bookmark: string | null | undefined,
    fence: LeadershipFence,
  ) {
    const oldPlan: ActivitySyncPlan = {
      localScopeKey: activityScopeKey('following', plan.oldRevision),
      scope: { scopeKind: 'following', followingRevision: plan.oldRevision },
      targetThroughSeq: plan.targetThroughSeq,
    }
    const [oldCoverage, oldLane] = await Promise.all([
      this.database.coverage.get(oldPlan.localScopeKey),
      this.database.syncLanes.get(oldPlan.localScopeKey),
    ])
    let oldLaneContinuous = Boolean(
      oldLane?.stableThroughSeq &&
      !oldLane.checkpointAfterHistory &&
      oldCoverage?.integrity !== 'gap-detected',
    )
    if (oldLaneContinuous) {
      try {
        oldLaneContinuous = await this.advanceActivityTo(oldPlan, bookmark, fence)
      } catch (error) {
        if (!(error instanceof CloudReplicaError) || error.code !== 'SNAPSHOT_EXPIRED') throw error
        oldLaneContinuous = false
      }
    }

    let completedReplacementHistory = false
    let completedAddedActorHistory = plan.addedActorCount === 0
    if (!oldLaneContinuous) {
      await this.pullCompleteHistory(
        {
          localScopeKey: activityScopeKey('following', plan.newRevision),
          scope: { scopeKind: 'following', followingRevision: plan.newRevision },
          targetThroughSeq: plan.targetThroughSeq,
        },
        bookmark,
        fence,
      )
      completedReplacementHistory = true
    } else if (plan.addedActorCount > 0) {
      let cursorActorKey: string | null = null
      let processedActorCount = 0
      for (let batchCount = 0; batchCount < 10_000; batchCount += 1) {
        const additions: FollowingAdditionRow[] = await this.database.followingAdditions
          .where('[snapshotRevision+actorKey]')
          .between(
            [plan.newRevision, cursorActorKey ?? Dexie.minKey],
            [plan.newRevision, Dexie.maxKey],
            cursorActorKey === null,
            true,
          )
          .limit(250)
          .toArray()
        if (additions.length === 0) {
          if (processedActorCount !== plan.addedActorCount) {
            throw new Error('Following transition additions changed')
          }
          completedAddedActorHistory = true
          break
        }
        const actorKeys = additions.map(addition => addition.actorKey) as [string, ...string[]]
        // oxlint-disable-next-line react-doctor/async-await-in-loop -- each persisted batch advances the same fenced transition
        await this.pullCompleteHistory(
          {
            localScopeKey: activityScopeKey(actorKeys, plan.newRevision),
            scope: { scopeKind: 'actors', actorKeys },
            targetThroughSeq: plan.targetThroughSeq,
          },
          bookmark,
          fence,
        )
        processedActorCount += additions.length
        cursorActorKey = additions.at(-1)!.actorKey
      }
      if (!completedAddedActorHistory) {
        throw new Error('Following transition additions exceeded the batch safety limit')
      }
    }

    await this.assertFence(fence)
    const revision = await this.database.transaction(
      'rw',
      [
        this.database.meta,
        this.database.followingMembers,
        this.database.followingMemberships,
        this.database.followingAdditions,
        this.database.followingState,
        this.database.syncLanes,
        this.database.coverage,
        this.database.syncLease,
      ],
      async () => {
        await assertTransactionLeadership(this.database, fence)
        const localScopeKey = activityScopeKey('following', plan.newRevision)
        const [existing, existingCoverage] = await Promise.all([
          this.database.syncLanes.get(localScopeKey),
          this.database.coverage.get(localScopeKey),
        ])
        await this.database.syncLanes.put({
          scopeKey: localScopeKey,
          kind: 'activity',
          remoteScopeKey: existing?.remoteScopeKey ?? null,
          stableThroughSeq:
            existing?.stableThroughSeq &&
            compareDecimalSequence(existing.stableThroughSeq, plan.targetThroughSeq) > 0
              ? existing.stableThroughSeq
              : plan.targetThroughSeq,
          historyThroughSeq: existing?.historyThroughSeq ?? null,
          historyCursor: existing?.historyCursor ?? null,
          historyRetentionFingerprint: existing?.historyRetentionFingerprint ?? null,
          checkpointAfterHistory: existing?.checkpointAfterHistory ?? false,
          historyBudgetToken: existing?.historyBudgetToken ?? null,
          historyBudgetExhausted: existing?.historyBudgetExhausted ?? false,
          historyBudgetPageCount: existing?.historyBudgetPageCount ?? 0,
          historyBudgetItemCount: existing?.historyBudgetItemCount ?? 0,
          deltaThroughSeq: null,
          deltaCursor: null,
          deltaRetentionFingerprint: null,
          lastUsedAt: this.#now(),
        })
        await this.database.coverage.put({
          scopeKey: localScopeKey,
          ...deriveFollowingTransitionCoverage({
            oldRemoteWindow: oldCoverage?.remoteWindow ?? null,
            existingRemoteWindow: existingCoverage?.remoteWindow ?? null,
            completedReplacementHistory,
            completedAddedActorHistory,
          }),
        })
        const followingState = await this.database.followingState.get('active')
        if (
          followingState?.pendingTransition?.oldRevision === plan.oldRevision &&
          followingState.pendingTransition.newRevision === plan.newRevision
        ) {
          const oldLocalScopeKey = activityScopeKey('following', plan.oldRevision)
          await Promise.all([
            this.database.followingMembers
              .where('snapshotRevision')
              .equals(plan.oldRevision)
              .delete(),
            this.database.followingMemberships
              .where('snapshotRevision')
              .equals(plan.oldRevision)
              .delete(),
            this.database.followingAdditions
              .where('snapshotRevision')
              .equals(plan.newRevision)
              .delete(),
            this.database.syncLanes.delete(oldLocalScopeKey),
            this.database.coverage.delete(oldLocalScopeKey),
          ])
          await this.database.followingState.put({
            key: 'active',
            ...completeFollowingTransition(followingState, plan),
          })
        }
        return incrementLocalRevision(this.database)
      },
    )
    await this.assertFence(fence)
    await this.changed(revision)
  }

  private async advanceActivityTo(
    plan: ActivitySyncPlan,
    bookmark: string | null | undefined,
    fence: LeadershipFence,
  ) {
    for (let pageCount = 0; pageCount < 1000; pageCount += 1) {
      const lane = await this.database.syncLanes.get(plan.localScopeKey)
      if (!lane?.stableThroughSeq) return true
      if (!canPullActivityDelta(lane)) return false
      if (
        !lane.deltaCursor &&
        compareDecimalSequence(lane.stableThroughSeq, plan.targetThroughSeq) >= 0
      ) {
        return true
      }
      const expectedCursor = lane.deltaCursor
      let page: ActivityDeltaPage
      try {
        await this.beforeCloudRequest(fence)
        page = await this.cloud!.getActivityDeltaPage(
          completeSyncPageInput({
            ...plan.scope,
            fromSeq: lane.stableThroughSeq,
            ...(expectedCursor ? { cursor: expectedCursor } : {}),
            ...(!expectedCursor ? { targetThroughSeq: plan.targetThroughSeq } : {}),
            ...(bookmark ? { bookmark } : {}),
          }),
        )
      } catch (error) {
        if (!(error instanceof CloudReplicaError) || error.code !== 'RETENTION_CHANGED') {
          throw error
        }
        await this.recoverActivityRetention(plan.localScopeKey, fence)
        return false
      }
      await this.assertFence(fence)
      if (page.gap) {
        const revision = await markActivityGap({
          database: this.database,
          localScopeKey: plan.localScopeKey,
          now: this.#now(),
          fence,
        })
        await this.assertFence(fence)
        await this.changed(revision)
        return false
      }
      const revision = await commitDeltaPage({
        database: this.database,
        ownerGithubId: this.owner.ownerGithubId,
        localScopeKey: plan.localScopeKey,
        expectedCursor,
        page,
        sanitizer: this.sanitizer!,
        now: this.#now(),
        fence,
      })
      await this.assertFence(fence)
      await this.changed(revision)
      await this.advanceWorkingProgress('activity', fence)
    }
    throw new Error('Following transition delta exceeded the page safety limit')
  }

  private async pullCompleteHistory(
    plan: ActivitySyncPlan,
    bookmark: string | null | undefined,
    fence: LeadershipFence,
  ) {
    await this.setWorking('activity', fence)
    await this.advanceActivityTo(plan, bookmark, fence)
    for (let pageCount = 0; pageCount < 10_000; pageCount += 1) {
      const [lane, coverage] = await Promise.all([
        this.database.syncLanes.get(plan.localScopeKey),
        this.database.coverage.get(plan.localScopeKey),
      ])
      if (coverage?.remoteWindow === 'exhausted') return
      const expectedCursor = lane?.historyCursor ?? null
      let page: ActivityHistoryPage
      try {
        await this.beforeCloudRequest(fence)
        page = await this.cloud!.getActivityHistoryPage(
          completeSyncPageInput({
            ...plan.scope,
            ...(expectedCursor
              ? { cursor: expectedCursor }
              : { targetThroughSeq: plan.targetThroughSeq }),
            ...(bookmark ? { bookmark } : {}),
          }),
        )
      } catch (error) {
        if (!(error instanceof CloudReplicaError) || error.code !== 'RETENTION_CHANGED') {
          throw error
        }
        if (!(await this.recoverActivityRetention(plan.localScopeKey, fence))) throw error
        continue
      }
      await this.assertFence(fence)
      const revision = await commitHistoryPage({
        database: this.database,
        ownerGithubId: this.owner.ownerGithubId,
        localScopeKey: plan.localScopeKey,
        expectedCursor,
        page,
        sanitizer: this.sanitizer!,
        now: this.#now(),
        fence,
      })
      await this.assertFence(fence)
      await this.changed(revision)
      await this.advanceWorkingProgress('activity', fence)
      if (page.remoteWindowEnd) return
      if (!page.nextCursor) throw new Error('Activity history ended without a remote-window marker')
    }
    throw new Error('Following transition history exceeded the page safety limit')
  }

  private async recoverActivityRetention(localScopeKey: string, fence: LeadershipFence) {
    if (!(await this.database.syncLanes.get(localScopeKey))) return false
    const revision = await markActivityGap({
      database: this.database,
      localScopeKey,
      now: this.#now(),
      fence,
    })
    await this.assertFence(fence)
    await this.changed(revision)
    return true
  }

  private async syncUserState(
    manifest: RevisionManifest,
    bookmark: string | null | undefined,
    fence: LeadershipFence,
  ) {
    const local = await this.database.syncState.get('user-state')
    if (
      local?.userStateRevision === manifest.userState.revision &&
      local.userStateEpoch === manifest.userState.epoch
    ) {
      return
    }
    await this.setWorking('user-state', fence)
    const pages = []
    let afterSeq = local?.userStateRevision
    let nextCursor: string | undefined
    for (let pageCount = 0; pageCount < 100; pageCount += 1) {
      await this.beforeCloudRequest(fence)
      const page = await this.cloud!.pullUserState(
        completeSyncPageInput({
          ...(afterSeq ? { afterSeq } : {}),
          ...(local?.userStateEpoch ? { epoch: local.userStateEpoch } : {}),
          ...(bookmark ? { bookmark } : {}),
        }),
      )
      await this.assertFence(fence)
      pages.push(page)
      await this.advanceWorkingProgress('user-state', fence)
      nextCursor = page.nextCursor ?? undefined
      if (!nextCursor) break
      afterSeq = nextCursor
    }
    if (nextCursor) throw new Error('User-state snapshot exceeded the page safety limit')
    const revision = await applyUserStatePages({
      database: this.database,
      ownerGithubId: this.owner.ownerGithubId,
      pages,
      now: this.#now(),
      fence,
    })
    await this.assertFence(fence)
    if (revision !== null) await this.changed(revision)
  }

  private async flushOutbox(bookmark: string | null | undefined, fence: LeadershipFence) {
    await this.setWorking('user-state', fence)
    for (let count = 0; count < 100; count += 1) {
      await this.assertFence(fence)
      const prepared = await prepareNextMutation({
        database: this.database,
        createId: this.#createId,
        now: this.#now(),
        fence,
      })
      if (prepared.localRevision !== null) await this.changed(prepared.localRevision)
      const { mutation } = prepared
      if (!mutation) {
        if ((await this.database.outbox.where('status').equals('pending').count()) === 0) return
        continue
      }
      await this.beforeCloudRequest(fence)
      const result = await this.cloud!.pushUserMutation({
        mutation,
        ...(bookmark ? { bookmark } : {}),
      })
      await this.assertFence(fence)
      const revision = await applyMutationResult({
        database: this.database,
        ownerGithubId: this.owner.ownerGithubId,
        mutationId: mutation.mutationId,
        result,
        createId: this.#createId,
        now: this.#now(),
        fence,
      })
      await this.assertFence(fence)
      if (revision !== null) await this.changed(revision)
      await this.advanceWorkingProgress('user-state', fence)
    }
    throw new Error('User-state outbox exceeded the operation safety limit')
  }

  private async changed(revision: number, scope: 'data' | 'status' = 'data') {
    this.tabs.announce({ kind: 'local-revision', revision, scope })
    await this.onLocalChange(scope)
  }

  private async setWorking(
    phase: Extract<LocalSyncStatus, { kind: 'working' }>['phase'],
    fence: LeadershipFence,
  ) {
    await this.setStatus(
      {
        kind: 'working',
        phase,
        progress: syncProgressForCompletedCheckpoints(this.#completedSyncCheckpoints),
        pendingUserOperations: await this.database.outbox.count(),
      },
      fence,
    )
  }

  private async advanceWorkingProgress(
    phase: Extract<LocalSyncStatus, { kind: 'working' }>['phase'],
    fence: LeadershipFence,
  ) {
    this.#completedSyncCheckpoints += 1
    await this.setWorking(phase, fence)
  }

  private async setQuiet(fence: LeadershipFence) {
    await this.setStatus(
      {
        kind: 'quiet',
        pendingUserOperations: await this.database.outbox.count(),
      },
      fence,
    )
  }

  private async setStatus(status: LocalSyncStatus, fence: LeadershipFence) {
    if (!(await fence.isCurrent()) || !(await this.generations.isCurrent(this.owner))) return
    this.database.volatileSyncStatus = status
    try {
      const revision = await this.database.transaction(
        'rw',
        this.database.meta,
        this.database.syncState,
        this.database.syncLease,
        async () => {
          await assertTransactionLeadership(this.database, fence)
          const previous = await this.database.syncState.get('status')
          const row: SyncStateRow = {
            ...previous,
            key: 'status',
            status,
            ...(status.lastCloudContactAt !== undefined
              ? { lastCloudContactAt: status.lastCloudContactAt }
              : previous?.lastCloudContactAt !== undefined
                ? { lastCloudContactAt: previous.lastCloudContactAt }
                : {}),
          }
          const retryAt =
            status.kind === 'degraded'
              ? status.retryAt
              : status.kind === 'offline'
                ? (this.#retryAt ?? previous?.retryAt)
                : undefined
          if (retryAt !== undefined && retryAt > this.#now()) row.retryAt = retryAt
          else delete row.retryAt
          await this.database.syncState.put(row)
          return incrementLocalRevision(this.database)
        },
      )
      await this.changed(revision, 'status')
    } catch {
      if (!(await fence.isCurrent()) || !(await this.generations.isCurrent(this.owner))) return
      let revision = this.database.volatileLocalRevision + 1
      try {
        revision = (await readLocalRevision(this.database)) + 1
      } catch {
        // Reads can fail alongside a quota or IndexedDB failure; the in-memory revision remains usable.
      }
      this.database.volatileLocalRevision = revision
      this.tabs.announce({ kind: 'local-revision', revision, scope: 'status' })
      await this.onLocalChange('status')
    }
  }
}
