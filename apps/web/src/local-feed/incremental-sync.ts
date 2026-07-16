import Dexie from 'dexie'

import type { AccountGeneration, AccountGenerationPort } from './account-generation'
import { isValidActivityProjectionId, normalizeActivityProjectionId } from './activity-id'
import { readActivityProjectionContext } from './activity-projection'
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
import { readAuthorizedActorSelection } from './following-membership'
import { activityScopeKey, readProjection } from './projections'
import {
  commitActivityById,
  commitDeltaPage,
  commitHistoryPage,
  compareDecimalSequence,
  exhaustActivityHistoryBudget,
  finalizeFollowingSnapshot,
  markActivityGap,
  prepareActivityHistoryBudget,
  stageFollowingPage,
} from './replica-writes'
import { assertTransactionLeadership } from './tab-coordinator'
import type { LeadershipFence, TabAnnouncement, TabCoordinatorPort } from './tab-coordinator'
import type { SyncLifecyclePort } from './sync-lifecycle'
import { isStorageQuotaError } from './storage-errors'
import type { FeedView, LocalSyncStatus, Projection } from './types'
import { applyMutationResult, applyUserStatePages, prepareNextMutation } from './user-state'

type Demand = { key: string; projection: Projection; count: number }
type RemoteDemand = Demand & { expiresAt: number }

type ActivityDemand = {
  localScopeKey: string
  scope: ReplicaScope
  projections: Extract<Projection, { kind: 'visible-feed' }>[]
}

class ForegroundSyncPaused extends Error {}

class RateLimitSyncPaused extends Error {}

const REMOTE_DEMAND_LEASE_MS = 15 * 60 * 1000

export function remoteDemandLeaseExpiresAt(now: number) {
  return now + REMOTE_DEMAND_LEASE_MS
}

export function remoteDemandLeaseIsCurrent(expiresAt: number | undefined, now: number) {
  return expiresAt !== undefined && Number.isFinite(expiresAt) && expiresAt > now
}

export function followingManifestRequiresReauthentication(manifest: RevisionManifest) {
  return manifest.following.reauthRequiredAt != null
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

export function canReuseTerminalActivityResolution(
  current: Pick<
    SyncStateRow,
    'activityResult' | 'activityResultAtHeadSeq' | 'activityResultAtFollowingRevision'
  > | null,
  manifest: RevisionManifest | null,
) {
  return Boolean(
    manifest &&
    (current?.activityResult === 'not-authorized' || current?.activityResult === 'cloud-miss') &&
    current.activityResultAtHeadSeq === manifest.activity.headSeq &&
    current.activityResultAtFollowingRevision === manifest.following.revision,
  )
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

export function shouldPullActivityHistory(
  lane: Pick<SyncLaneRow, 'checkpointAfterHistory' | 'stableThroughSeq'> | null | undefined,
  demandSatisfied: boolean,
  remoteWindow: 'exhausted' | 'may-have-more' | 'unchecked' | undefined,
) {
  return (
    !lane?.stableThroughSeq ||
    Boolean(lane.checkpointAfterHistory) ||
    (!demandSatisfied && remoteWindow !== 'exhausted')
  )
}

export function activityHistoryBudgetToken(
  projections: readonly Extract<Projection, { kind: 'visible-feed' }>[],
  visibilitySignature: string,
) {
  return JSON.stringify({
    projections: [...new Set(projections.map(canonicalProjectionKey))].sort(),
    visibilitySignature,
  })
}

function isAccountMismatch(error: unknown) {
  return error instanceof Error && error.message.includes('viewer mismatch')
}

export class IncrementalSync {
  readonly #tabId = crypto.randomUUID()
  readonly #localDemands = new Map<string, Demand>()
  readonly #remoteDemands = new Map<string, RemoteDemand>()
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
  #continuationTimer: ReturnType<typeof setTimeout> | null = null
  #unavailableAttempts = 0

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
    this.#unsubscribeLifecycle = this.lifecycle.subscribe(() => {
      if (this.lifecycle.isVisible()) this.announceLocalDemands()
      this.requestSync()
    })
    this.#unsubscribeTabs = this.tabs.subscribe(event => this.onTabAnnouncement(event))
    this.requestSync()
  }

  declareDemand(projection: Projection) {
    const canonicalProjection = canonicalizeProjection(projection)
    if (
      canonicalProjection.kind === 'activity' &&
      !isValidActivityProjectionId(canonicalProjection.id)
    ) {
      return () => undefined
    }
    const key = canonicalProjectionKey(canonicalProjection)
    const existing = this.#localDemands.get(key)
    if (existing) existing.count += 1
    else {
      this.#localDemands.set(key, { key, projection: canonicalProjection, count: 1 })
      this.tabs.announce({
        kind: 'demand-changed',
        tabId: this.#tabId,
        demandKey: key,
        projection: canonicalProjection,
        active: true,
        expiresAt: remoteDemandLeaseExpiresAt(this.#now()),
      })
    }
    this.requestSync()

    return () => {
      const current = this.#localDemands.get(key)
      if (!current) return
      current.count -= 1
      if (current.count > 0) return
      this.#localDemands.delete(key)
      this.tabs.announce({
        kind: 'demand-changed',
        tabId: this.#tabId,
        demandKey: key,
        projection: canonicalProjection,
        active: false,
      })
    }
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
    if (this.#continuationTimer) clearTimeout(this.#continuationTimer)
    this.#continuationTimer = null
    for (const demand of this.#localDemands.values()) {
      this.tabs.announce({
        kind: 'demand-changed',
        tabId: this.#tabId,
        demandKey: demand.key,
        projection: demand.projection,
        active: false,
      })
    }
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
      return
    }
    if (event.kind !== 'demand-changed' || event.tabId === this.#tabId) return
    const key = `${event.tabId}:${event.demandKey}`
    if (event.active && remoteDemandLeaseIsCurrent(event.expiresAt, this.#now())) {
      this.#remoteDemands.set(key, {
        key,
        projection: event.projection,
        count: 1,
        expiresAt: event.expiresAt!,
      })
    } else {
      this.#remoteDemands.delete(key)
    }
    this.requestSync()
  }

  private allDemands() {
    for (const [key, demand] of this.#remoteDemands) {
      if (!remoteDemandLeaseIsCurrent(demand.expiresAt, this.#now())) {
        this.#remoteDemands.delete(key)
      }
    }
    return [...this.#localDemands.values(), ...this.#remoteDemands.values()]
  }

  private announceLocalDemands() {
    const expiresAt = remoteDemandLeaseExpiresAt(this.#now())
    for (const demand of this.#localDemands.values()) {
      this.tabs.announce({
        kind: 'demand-changed',
        tabId: this.#tabId,
        demandKey: demand.key,
        projection: demand.projection,
        active: true,
        expiresAt,
      })
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

  private scheduleForegroundContinuation() {
    if (this.#closed || this.#continuationTimer) return
    this.#continuationTimer = setTimeout(() => {
      this.#continuationTimer = null
      if (!this.#closed && this.lifecycle.isVisible() && this.lifecycle.isOnline()) {
        this.requestSync()
      }
    }, 250)
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
          hasUnmetDemand: this.allDemands().length > 0,
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
      await this.assertSyncPhase(fence)
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
          if (retryImmediately) this.#requested = true
          return
        }
        await this.syncUserState(manifest, bookmark, fence)
      }

      await this.flushOutbox(bookmark, fence)
      await this.syncDemands(manifest, bookmark, fence)
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
      if (error instanceof ForegroundSyncPaused || error instanceof RateLimitSyncPaused) {
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
            hasUnmetDemand: this.allDemands().length > 0,
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
    await this.assertSyncPhase(fence)

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
      const page = await this.cloud!.getFollowingPage({
        revision: manifest.following.revision,
        ...(cursor ? { cursor } : {}),
        ...(bookmark ? { bookmark } : {}),
      })
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
    const oldDemand: ActivityDemand = {
      localScopeKey: activityScopeKey('following', plan.oldRevision),
      scope: { scopeKind: 'following', followingRevision: plan.oldRevision },
      projections: [],
    }
    const [oldCoverage, oldLane] = await Promise.all([
      this.database.coverage.get(oldDemand.localScopeKey),
      this.database.syncLanes.get(oldDemand.localScopeKey),
    ])
    let oldLaneContinuous = Boolean(
      oldLane?.stableThroughSeq &&
      !oldLane.checkpointAfterHistory &&
      oldCoverage?.integrity !== 'gap-detected',
    )
    if (oldLaneContinuous) {
      try {
        oldLaneContinuous = await this.advanceActivityTo(
          oldDemand,
          plan.targetThroughSeq,
          bookmark,
          fence,
        )
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
          projections: [],
        },
        plan.targetThroughSeq,
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
            projections: [],
          },
          plan.targetThroughSeq,
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
    demand: ActivityDemand,
    targetThroughSeq: string,
    bookmark: string | null | undefined,
    fence: LeadershipFence,
  ) {
    for (let pageCount = 0; pageCount < 1000; pageCount += 1) {
      const lane = await this.database.syncLanes.get(demand.localScopeKey)
      if (!lane?.stableThroughSeq) return true
      if (!canPullActivityDelta(lane)) return false
      if (
        !lane.deltaCursor &&
        compareDecimalSequence(lane.stableThroughSeq, targetThroughSeq) >= 0
      ) {
        return true
      }
      const expectedCursor = lane.deltaCursor
      let page: ActivityDeltaPage
      try {
        await this.beforeCloudRequest(fence)
        page = await this.cloud!.getActivityDeltaPage({
          ...demand.scope,
          fromSeq: lane.stableThroughSeq,
          ...(expectedCursor ? { cursor: expectedCursor } : {}),
          ...(!expectedCursor ? { targetThroughSeq } : {}),
          ...(bookmark ? { bookmark } : {}),
        })
      } catch (error) {
        if (!(error instanceof CloudReplicaError) || error.code !== 'RETENTION_CHANGED') {
          throw error
        }
        await this.recoverActivityRetention(demand.localScopeKey, fence)
        return false
      }
      await this.assertFence(fence)
      if (page.gap) {
        const revision = await markActivityGap({
          database: this.database,
          localScopeKey: demand.localScopeKey,
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
        localScopeKey: demand.localScopeKey,
        expectedCursor,
        page,
        sanitizer: this.sanitizer!,
        now: this.#now(),
        fence,
      })
      await this.assertFence(fence)
      await this.changed(revision)
    }
    throw new Error('Following transition delta exceeded the page safety limit')
  }

  private async pullCompleteHistory(
    demand: ActivityDemand,
    targetThroughSeq: string,
    bookmark: string | null | undefined,
    fence: LeadershipFence,
  ) {
    const continuous = await this.advanceActivityTo(demand, targetThroughSeq, bookmark, fence)
    if (!continuous) {
      // The replacement history transaction will establish the checkpoint only at its end.
    }
    for (let pageCount = 0; pageCount < 10_000; pageCount += 1) {
      const [lane, coverage] = await Promise.all([
        this.database.syncLanes.get(demand.localScopeKey),
        this.database.coverage.get(demand.localScopeKey),
      ])
      if (coverage?.remoteWindow === 'exhausted') return
      const expectedCursor = lane?.historyCursor ?? null
      let page: ActivityHistoryPage
      try {
        await this.beforeCloudRequest(fence)
        page = await this.cloud!.getActivityHistoryPage({
          ...demand.scope,
          ...(expectedCursor ? { cursor: expectedCursor } : { targetThroughSeq }),
          ...(bookmark ? { bookmark } : {}),
        })
      } catch (error) {
        if (!(error instanceof CloudReplicaError) || error.code !== 'RETENTION_CHANGED') {
          throw error
        }
        if (!(await this.recoverActivityRetention(demand.localScopeKey, fence))) throw error
        continue
      }
      await this.assertFence(fence)
      const revision = await commitHistoryPage({
        database: this.database,
        ownerGithubId: this.owner.ownerGithubId,
        localScopeKey: demand.localScopeKey,
        expectedCursor,
        page,
        sanitizer: this.sanitizer!,
        now: this.#now(),
        historyBudgetToken: null,
        fence,
      })
      await this.assertFence(fence)
      await this.changed(revision)
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
    await this.assertSyncPhase(fence)
    const pages = []
    let afterSeq = local?.userStateRevision
    let nextCursor: string | undefined
    for (let pageCount = 0; pageCount < 100; pageCount += 1) {
      await this.beforeCloudRequest(fence)
      const page = await this.cloud!.pullUserState({
        ...(afterSeq ? { afterSeq } : {}),
        ...(local?.userStateEpoch ? { epoch: local.userStateEpoch } : {}),
        ...(bookmark ? { bookmark } : {}),
      })
      await this.assertFence(fence)
      pages.push(page)
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
    await this.assertSyncPhase(fence)
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
    }
    throw new Error('User-state outbox exceeded the operation safety limit')
  }

  private async syncDemands(
    manifest: RevisionManifest | null,
    bookmark: string | null | undefined,
    fence: LeadershipFence,
  ) {
    const demands = this.allDemands()
    for (const demand of demands) {
      if (demand.projection.kind === 'activity') {
        // oxlint-disable-next-line react-doctor/async-await-in-loop -- bounded sequential requests avoid an unbounded detail fan-out
        await this.syncActivityById(demand.projection.id, manifest, bookmark, fence)
      }
    }

    const activityDemands = await this.activityDemands(demands)
    for (const demand of activityDemands) {
      // oxlint-disable-next-line react-doctor/async-await-in-loop -- scopes share the fenced local replica and safety budget
      await this.syncActivityScope(demand, manifest, bookmark, fence)
    }
  }

  private async activityDemands(demands: readonly Demand[]): Promise<ActivityDemand[]> {
    const following = await this.database.followingState.get('active')
    if (!following?.activeRevision) return []
    const grouped = new Map<string, ActivityDemand>()

    for (const { projection } of demands) {
      let actors: FeedView['actors'] | null = null
      if (projection.kind === 'visible-feed') actors = projection.view.actors
      else if (projection.kind === 'statistics') actors = projection.actors
      if (!actors) continue

      const authorized =
        actors === 'following'
          ? 'following'
          : (await readAuthorizedActorSelection(this.database, following.activeRevision, actors))
              .actorKeys
      if (authorized !== 'following' && authorized.length === 0) continue
      const remoteActors =
        authorized !== 'following' && authorized.length > 250 ? 'following' : authorized
      const localScopeKey = activityScopeKey(
        remoteActors as 'following' | readonly [string, ...string[]],
        following.activeRevision,
      )
      const existing = grouped.get(localScopeKey)
      const visibleProjection = projection.kind === 'visible-feed' ? projection : null
      if (existing) {
        if (visibleProjection) existing.projections.push(visibleProjection)
        continue
      }
      grouped.set(localScopeKey, {
        localScopeKey,
        scope:
          remoteActors === 'following'
            ? { scopeKind: 'following', followingRevision: following.activeRevision }
            : {
                scopeKind: 'actors',
                actorKeys: [...remoteActors].sort() as unknown as readonly [string, ...string[]],
              },
        projections: visibleProjection ? [visibleProjection] : [],
      })
    }
    return [...grouped.values()]
  }

  private async syncActivityScope(
    demand: ActivityDemand,
    manifest: RevisionManifest | null,
    bookmark: string | null | undefined,
    fence: LeadershipFence,
  ) {
    await this.assertSyncPhase(fence)
    let lane = await this.database.syncLanes.get(demand.localScopeKey)
    if (
      lane?.stableThroughSeq &&
      canPullActivityDelta(lane) &&
      (lane.deltaCursor ||
        (manifest && compareDecimalSequence(lane.stableThroughSeq, manifest.activity.headSeq) < 0))
    ) {
      for (let pageCount = 0; pageCount < 5; pageCount += 1) {
        lane = await this.database.syncLanes.get(demand.localScopeKey)
        if (!lane?.stableThroughSeq || lane.checkpointAfterHistory) break
        const expectedCursor = lane.deltaCursor
        let page: ActivityDeltaPage
        try {
          await this.beforeCloudRequest(fence)
          page = await this.cloud!.getActivityDeltaPage({
            ...demand.scope,
            fromSeq: lane.stableThroughSeq,
            ...(expectedCursor ? { cursor: expectedCursor } : {}),
            ...(manifest ? { targetThroughSeq: manifest.activity.headSeq } : {}),
            ...(bookmark ? { bookmark } : {}),
          })
        } catch (error) {
          if (!(error instanceof CloudReplicaError) || error.code !== 'RETENTION_CHANGED') {
            throw error
          }
          await this.recoverActivityRetention(demand.localScopeKey, fence)
          break
        }
        await this.assertFence(fence)
        if (page.gap) {
          const revision = await markActivityGap({
            database: this.database,
            localScopeKey: demand.localScopeKey,
            now: this.#now(),
            fence,
          })
          await this.assertFence(fence)
          await this.changed(revision)
          lane = await this.database.syncLanes.get(demand.localScopeKey)
          break
        }
        const revision = await commitDeltaPage({
          database: this.database,
          ownerGithubId: this.owner.ownerGithubId,
          localScopeKey: demand.localScopeKey,
          expectedCursor,
          page,
          sanitizer: this.sanitizer!,
          now: this.#now(),
          fence,
        })
        await this.assertFence(fence)
        await this.changed(revision)
        if (!page.nextCursor) break
      }
      if ((await this.database.syncLanes.get(demand.localScopeKey))?.deltaCursor) {
        this.scheduleForegroundContinuation()
      }
    }

    const visibility = await readActivityProjectionContext(this.database, this.sanitizer)
    const budgetToken = activityHistoryBudgetToken(demand.projections, visibility.signature)
    const startedAt = this.#now()
    for (let pageCount = 0; pageCount < 5; pageCount += 1) {
      const coverage = await this.database.coverage.get(demand.localScopeKey)
      lane = await this.database.syncLanes.get(demand.localScopeKey)
      const replacingGap = lane?.checkpointAfterHistory === true
      if (
        !replacingGap &&
        !(await prepareActivityHistoryBudget({
          database: this.database,
          localScopeKey: demand.localScopeKey,
          token: budgetToken,
          now: this.#now(),
          fence,
        }))
      ) {
        return
      }
      const allSatisfied = await this.isDemandSatisfied(demand)
      if (!shouldPullActivityHistory(lane, allSatisfied, coverage?.remoteWindow)) return
      const expectedCursor = lane?.historyCursor ?? null
      let page: ActivityHistoryPage
      try {
        await this.beforeCloudRequest(fence)
        page = await this.cloud!.getActivityHistoryPage({
          ...demand.scope,
          ...(expectedCursor ? { cursor: expectedCursor } : {}),
          ...(!expectedCursor && manifest ? { targetThroughSeq: manifest.activity.headSeq } : {}),
          ...(bookmark ? { bookmark } : {}),
        })
      } catch (error) {
        if (!(error instanceof CloudReplicaError) || error.code !== 'RETENTION_CHANGED') {
          throw error
        }
        if (!(await this.recoverActivityRetention(demand.localScopeKey, fence))) throw error
        continue
      }
      await this.assertFence(fence)
      const revision = await commitHistoryPage({
        database: this.database,
        ownerGithubId: this.owner.ownerGithubId,
        localScopeKey: demand.localScopeKey,
        expectedCursor,
        page,
        sanitizer: this.sanitizer!,
        now: this.#now(),
        historyBudgetToken: replacingGap ? null : budgetToken,
        fence,
      })
      await this.assertFence(fence)
      await this.changed(revision)
      if (page.remoteWindowEnd) return
      if (!page.nextCursor) {
        throw new Error('Activity history ended without a remote-window marker')
      }
      if (this.#now() - startedAt >= 2_000) {
        if (replacingGap) this.scheduleForegroundContinuation()
        else {
          await exhaustActivityHistoryBudget({
            database: this.database,
            localScopeKey: demand.localScopeKey,
            token: budgetToken,
            now: this.#now(),
            fence,
          })
        }
        return
      }
    }
    if ((await this.database.syncLanes.get(demand.localScopeKey))?.checkpointAfterHistory) {
      this.scheduleForegroundContinuation()
    } else {
      await exhaustActivityHistoryBudget({
        database: this.database,
        localScopeKey: demand.localScopeKey,
        token: budgetToken,
        now: this.#now(),
        fence,
      })
    }
  }

  private async isDemandSatisfied(demand: ActivityDemand) {
    if (demand.projections.length === 0) {
      return (await this.database.coverage.get(demand.localScopeKey))?.bootstrap === 'initialized'
    }
    for (const projection of demand.projections) {
      const snapshot = await readProjection(this.database, projection)
      if (snapshot.value.computation === 'rebuilding') continue
      if (snapshot.value.coverage.demand !== 'satisfied') return false
    }
    return true
  }

  private async syncActivityById(
    id: string,
    manifest: RevisionManifest | null,
    bookmark: string | null | undefined,
    fence: LeadershipFence,
  ) {
    if (await this.database.activities.get(id)) return
    const current = await this.database.syncState.get(`activity:${id}`)
    if (canReuseTerminalActivityResolution(current ?? null, manifest)) return
    if (current?.activityResult !== 'resolving') {
      await this.writeActivityResolution(id, 'resolving', fence)
    }
    let response: Awaited<ReturnType<CloudReplicaPort['getActivityById']>>
    try {
      await this.beforeCloudRequest(fence)
      response = await this.cloud!.getActivityById({
        id,
        ...(bookmark ? { bookmark } : {}),
      })
      await this.assertFence(fence)
    } catch (error) {
      try {
        await this.writeActivityResolution(
          id,
          this.lifecycle.isOnline() ? 'cloud-unavailable' : 'unavailable-offline',
          fence,
        )
      } catch {
        // The original cloud failure remains authoritative when local status persistence fails.
      }
      throw error
    }
    this.assertViewer(response.viewerGithubId)
    if (response.result.kind === 'found') {
      const revision = await commitActivityById({
        database: this.database,
        ownerGithubId: this.owner.ownerGithubId,
        viewerGithubId: response.viewerGithubId,
        activity: response.result.activity,
        sanitizer: this.sanitizer!,
        fence,
      })
      await this.assertFence(fence)
      await this.changed(revision)
      return
    }
    await this.writeActivityResolution(
      id,
      response.result.kind === 'not-authorized' ? 'not-authorized' : 'cloud-miss',
      fence,
      manifest,
    )
  }

  private async writeActivityResolution(
    id: string,
    activityResult: NonNullable<SyncStateRow['activityResult']>,
    fence: LeadershipFence,
    manifest?: RevisionManifest | null,
  ) {
    const revision = await this.database.transaction(
      'rw',
      this.database.meta,
      this.database.syncState,
      this.database.syncLease,
      async () => {
        await assertTransactionLeadership(this.database, fence)
        await this.database.syncState.put({
          key: `activity:${id}`,
          activityResult,
          ...((activityResult === 'not-authorized' || activityResult === 'cloud-miss') && manifest
            ? {
                activityResultAtHeadSeq: manifest.activity.headSeq,
                activityResultAtFollowingRevision: manifest.following.revision,
              }
            : {}),
        })
        return incrementLocalRevision(this.database)
      },
    )
    await this.assertFence(fence)
    await this.changed(revision)
  }

  private async changed(revision: number, scope: 'data' | 'status' = 'data') {
    this.tabs.announce({ kind: 'local-revision', revision, scope })
    await this.onLocalChange(scope)
  }

  private async assertSyncPhase(fence: LeadershipFence) {
    // Automatic checks must not replace the stable user-facing status or publish a
    // global local revision merely to expose transient progress.
    await this.assertFence(fence)
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
