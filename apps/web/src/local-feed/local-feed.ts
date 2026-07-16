import type { AccountGeneration, AccountGenerationPort } from './account-generation'
import { userFilterMutationValueSchema } from '@better-github-feed/contract'
import {
  advanceAccountDeletionIntent,
  advanceAccountLockIntent,
  StaleAccountGenerationError,
} from './account-generation'
import { maintainActivityProjection } from './activity-projection'
import type { ActivitySanitizerPort, CloudReplicaPort } from './cloud-replica'
import {
  assertDatabaseAccount,
  databaseNameForOwner,
  incrementLocalRevision,
  initializeDatabase,
  LocalFeedDatabase,
  runBoundedDatabaseDelete,
} from './database'
import type { FilterRow, OutboxRow } from './database'
import { canonicalizeProjection, IncrementalSync } from './incremental-sync'
import { readProjection } from './projections'
import { createBrowserSyncLifecyclePort, createManualSyncLifecyclePort } from './sync-lifecycle'
import type { SyncLifecyclePort } from './sync-lifecycle'
import { createBrowserStoragePersistencePort } from './storage-persistence'
import type { StoragePersistencePort } from './storage-persistence'
import { isStorageQuotaError } from './storage-errors'
import { createDexieTabCoordinator, createSingleTabCoordinator } from './tab-coordinator'
import type { TabCoordinatorPort } from './tab-coordinator'
import type {
  CloseReason,
  CloseResult,
  CommitReceipt,
  LiveProjection,
  LocalCommand,
  LocalFeed,
  Projection,
  ProjectionOutput,
  ProjectionSnapshot,
} from './types'

type ProjectionRead<T> = {
  localRevision: number
  value: T
}

export function projectionDependsOn(kind: Projection['kind'], scope: 'data' | 'status') {
  return scope === 'data' || kind === 'sync-status'
}

export function projectionMaintenanceRequestsSync(input: {
  promoted: boolean
  recoveredStorage: boolean
}) {
  return input.recoveredStorage
}

export function projectionMaintenanceRetryDelay(failureCount: number) {
  return Math.min(30_000, 1_000 * 2 ** Math.max(0, Math.min(5, failureCount - 1)))
}

class DexieLiveProjection<T> implements LiveProjection<T> {
  #snapshot: ProjectionSnapshot<T> = { kind: 'opening-local' }
  #listeners = new Set<() => void>()
  #disposed = false
  #readVersion = 0

  constructor(
    readonly kind: Projection['kind'],
    private readonly read: () => Promise<ProjectionRead<T>>,
  ) {
    void this.refresh()
  }

  getSnapshot(): ProjectionSnapshot<T> {
    return this.#snapshot
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  dispose(): void {
    this.#disposed = true
    this.#listeners.clear()
  }

  async refresh(): Promise<void> {
    if (this.#disposed) return
    const readVersion = ++this.#readVersion

    try {
      const next = await this.read()
      if (this.#disposed || readVersion !== this.#readVersion) return
      this.#snapshot = { kind: 'ready', ...next }
    } catch (cause) {
      if (this.#disposed || readVersion !== this.#readVersion) return
      this.#snapshot = {
        kind: 'failed',
        issue: 'local-query-failed',
        error: cause instanceof Error ? cause : new Error(String(cause)),
      }
    }

    for (const listener of this.#listeners) listener()
  }

  dependsOn(scope: 'data' | 'status') {
    return projectionDependsOn(this.kind, scope)
  }
}

export type OpenLocalFeedOptions = {
  /** A GitHub numeric user ID previously verified by the sync gateway or account registry. */
  ownerGithubId: string
  generations: AccountGenerationPort
  cloud?: CloudReplicaPort
  /** Required whenever cloud Activity can be committed to Dexie. */
  sanitizer?: ActivitySanitizerPort
  tabs?: TabCoordinatorPort
  lifecycle?: SyncLifecyclePort
  now?: () => number
  createId?: () => string
  onAccountInvalidated?: (generation: number) => void
  onAccountAttention?: (issue: 'reauth-required' | 'account-mismatch') => void
  storagePersistence?: StoragePersistencePort
}

class DexieLocalFeed implements LocalFeed {
  readonly #projections = new Set<DexieLiveProjection<unknown>>()
  readonly #now: () => number
  readonly #createId: () => string
  readonly #sync: IncrementalSync
  readonly #unsubscribeTabs: () => void
  readonly #sanitizer: ActivitySanitizerPort | undefined
  #closed = false
  #generationInvalid = false
  #maintenanceRunning = false
  #maintenanceRequested = false
  #maintenanceFailures = 0
  #maintenanceTimer: ReturnType<typeof setTimeout> | undefined
  #maintenancePromise: Promise<void> | null = null

  constructor(
    private readonly database: LocalFeedDatabase,
    private readonly owner: AccountGeneration,
    private readonly generations: AccountGenerationPort,
    private readonly tabs: TabCoordinatorPort,
    lifecycle: SyncLifecyclePort,
    options: Pick<
      OpenLocalFeedOptions,
      'now' | 'createId' | 'cloud' | 'sanitizer' | 'onAccountInvalidated' | 'onAccountAttention'
    >,
  ) {
    this.#now = options.now ?? Date.now
    this.#createId = options.createId ?? (() => crypto.randomUUID())
    this.#sanitizer = options.sanitizer
    this.#sync = new IncrementalSync(
      database,
      owner,
      generations,
      options.cloud,
      options.sanitizer,
      tabs,
      lifecycle,
      (scope = 'data') => this.handleLocalChange(scope),
      options,
    )
    this.#unsubscribeTabs = tabs.subscribe(event => {
      if (event.kind === 'local-revision') void this.handleLocalChange(event.scope ?? 'data')
      if (event.kind === 'projection-changed') void this.refreshProjections('data')
      if (
        event.kind === 'account-generation' &&
        (event.generation !== owner.generation || event.nonce !== owner.nonce)
      ) {
        this.#generationInvalid = true
        this.#maintenanceRequested = false
        if (this.#maintenanceTimer !== undefined) {
          clearTimeout(this.#maintenanceTimer)
          this.#maintenanceTimer = undefined
        }
        options.onAccountInvalidated?.(event.generation)
      }
    })
  }

  start() {
    this.#sync.start()
    this.scheduleProjectionMaintenance()
  }

  requestSync() {
    this.assertOpen()
    this.#sync.requestSync()
  }

  async requestStoragePersistence(port: StoragePersistencePort) {
    const result = await port.request()
    if (
      this.#closed ||
      this.#generationInvalid ||
      !this.database.isOpen() ||
      !(await this.generations.isCurrent(this.owner))
    ) {
      return
    }
    try {
      await this.database.transaction('rw', this.database.meta, async () => {
        const [owner, generation, nonce] = await Promise.all([
          this.database.meta.get('ownerGithubId'),
          this.database.meta.get('accountGeneration'),
          this.database.meta.get('accountGenerationNonce'),
        ])
        if (
          owner?.value !== this.owner.ownerGithubId ||
          generation?.value !== this.owner.generation ||
          nonce?.value !== this.owner.nonce
        ) {
          throw new StaleAccountGenerationError()
        }
        await this.database.meta.put({ key: 'storagePersistence', value: result })
        await this.database.meta.put({ key: 'storagePersistenceCheckedAt', value: this.#now() })
      })
    } catch {
      // Persistence is best-effort and must never block local data access.
    }
  }

  observe<P extends Projection>(projection: P): LiveProjection<ProjectionOutput<P>> {
    this.assertOpen()
    const canonicalProjection = canonicalizeProjection(projection)
    const live = new DexieLiveProjection(canonicalProjection.kind, async () =>
      readProjection(this.database, canonicalProjection, this.#sanitizer),
    )
    this.#projections.add(live as DexieLiveProjection<unknown>)
    this.scheduleProjectionMaintenance()

    return {
      getSnapshot: () => live.getSnapshot(),
      subscribe: listener => live.subscribe(listener),
      dispose: () => {
        live.dispose()
        this.#projections.delete(live as DexieLiveProjection<unknown>)
      },
    }
  }

  async commit(command: LocalCommand): Promise<CommitReceipt> {
    this.assertOpen()
    await this.assertGeneration()

    const mutationId = this.#createId()
    const attemptId = this.#createId()
    const createdAt = this.#now()

    const localRevision = await this.database.transaction(
      'rw',
      [
        this.database.meta,
        this.database.filters,
        this.database.filterReplicas,
        this.database.feedState,
        this.database.outbox,
        this.database.syncState,
      ],
      async () => {
        await assertDatabaseAccount(
          this.database,
          this.owner.ownerGithubId,
          this.owner.generation,
          this.owner.nonce,
        )
        const revision = await incrementLocalRevision(this.database)

        if (command.kind === 'filter.put') {
          const id = command.filter.id ?? this.#createId()
          const validated = userFilterMutationValueSchema.parse({
            id,
            name: command.filter.name,
            filterRule: command.filter.rule,
          })
          const [replica, current] = await Promise.all([
            this.database.filterReplicas.get(id),
            this.database.filters.get(id),
          ])
          const filter: FilterRow = {
            id,
            name: validated.name,
            rule: validated.filterRule,
            deletedAt: null,
            sync: 'pending',
            updatedAt: createdAt,
          }
          const outbox: OutboxRow = {
            mutationId,
            attemptId,
            localSequence: revision,
            entityKey: `filter:${id}`,
            baseVersion: replica?.entityVersion ?? 0,
            baseValue:
              current && current.deletedAt === null
                ? { name: current.name, rule: current.rule }
                : (replica?.value ?? null),
            operation: {
              kind: 'filter.put',
              filter: { id, name: validated.name, rule: validated.filterRule },
            },
            status: 'pending',
            conflictCopy: false,
            createdAt,
          }
          await Promise.all([
            this.database.filters.put(filter),
            this.database.outbox
              .where('entityKey')
              .equals(`filter:${id}`)
              .and(row => row.status === 'blocked')
              .delete(),
          ])
          await this.database.outbox.put(outbox)
        } else if (command.kind === 'filter.delete') {
          const replica = await this.database.filterReplicas.get(command.id)
          const current = await this.database.filters.get(command.id)
          if (current) {
            await this.database.filters.put({
              ...current,
              deletedAt: createdAt,
              sync: 'pending',
              updatedAt: createdAt,
            })
          }
          await this.database.outbox
            .where('entityKey')
            .equals(`filter:${command.id}`)
            .and(row => row.status === 'blocked')
            .delete()
          await this.database.outbox.put({
            mutationId,
            attemptId,
            localSequence: revision,
            entityKey: `filter:${command.id}`,
            baseVersion: replica?.entityVersion ?? 0,
            baseValue:
              current && current.deletedAt === null
                ? { name: current.name, rule: current.rule }
                : (replica?.value ?? null),
            operation: { kind: 'filter.delete', id: command.id },
            status: 'pending',
            conflictCopy: false,
            createdAt,
          })
        } else {
          const [current, control] = await Promise.all([
            this.database.feedState.get('active'),
            this.database.syncState.get('control'),
          ])
          const candidate =
            control?.manifestServerTime !== undefined &&
            control.manifestReceivedAt !== undefined &&
            control.manifestTimeAnchor
              ? control.manifestServerTime + Math.max(0, createdAt - control.manifestReceivedAt)
              : null
          await this.database.feedState.put({
            key: 'active',
            entityVersion: current?.entityVersion ?? 0,
            changedRevision: current?.changedRevision ?? '0',
            serverClearedAt: current?.serverClearedAt ?? null,
            optimisticClearedAt:
              candidate === null
                ? (current?.optimisticClearedAt ?? null)
                : Math.max(current?.optimisticClearedAt ?? candidate, candidate),
            provisionalThroughRevision: revision - 1,
          })
          await this.database.outbox.put({
            mutationId,
            attemptId,
            localSequence: revision,
            entityKey: 'feed-state',
            baseVersion: current?.entityVersion ?? 0,
            baseValue: current?.serverClearedAt ?? null,
            operation: {
              kind: 'feed.clear',
              candidate,
              timeAnchor: control?.manifestTimeAnchor ?? null,
            },
            status: 'pending',
            conflictCopy: false,
            createdAt,
          })
        }

        return revision
      },
    )

    await this.handleLocalChange('data')
    this.tabs.announce({
      kind: 'local-revision',
      revision: localRevision,
      requestsSync: true,
      scope: 'data',
    })
    this.#sync.requestSync()
    return { localRevision, mutationId, sync: 'queued' }
  }

  async close(reason: CloseReason): Promise<CloseResult> {
    if (this.#closed) return { kind: 'closed' }
    this.#closed = true
    this.#maintenanceRequested = false
    if (this.#maintenanceTimer !== undefined) {
      clearTimeout(this.#maintenanceTimer)
      this.#maintenanceTimer = undefined
    }
    await this.#maintenancePromise

    let fenceError: unknown
    let fencedAccount: AccountGeneration | null = null
    if (reason.kind === 'sign-out') {
      try {
        const next =
          reason.localData === 'retain-locked'
            ? await advanceAccountLockIntent(this.generations, this.owner.ownerGithubId)
            : await advanceAccountDeletionIntent(this.generations, this.owner.ownerGithubId)
        fencedAccount = next
        try {
          await this.database.transaction(
            'rw',
            this.database.meta,
            this.database.syncLease,
            async () => {
              await this.database.meta.put({ key: 'accountGeneration', value: next.generation })
              await this.database.meta.put({ key: 'accountGenerationNonce', value: next.nonce })
              await this.database.syncLease.delete('leader')
            },
          )
        } catch {
          // The external registry generation is the authoritative privacy
          // fence. A failing inner write must not undo an explicit deletion
          // or lock intent, especially during database recovery.
        } finally {
          this.tabs.announce({
            kind: 'account-generation',
            generation: next.generation,
            nonce: next.nonce,
          })
        }
      } catch (error) {
        fenceError = error
      }
    }

    try {
      await this.#sync.close()
    } finally {
      for (const projection of this.#projections) projection.dispose()
      this.#projections.clear()
      this.#unsubscribeTabs()
      this.database.close({ disableAutoOpen: true })
      this.tabs.close()
    }

    if (fenceError) {
      throw fenceError instanceof Error
        ? fenceError
        : new Error('Failed to fence the local account generation', { cause: fenceError })
    }

    if (reason.kind !== 'sign-out') {
      return { kind: 'closed' }
    }

    if (reason.localData === 'retain-locked') {
      return { kind: 'retained-locked' }
    }

    try {
      const deletion = await runBoundedDatabaseDelete(() => this.database.delete())
      if (deletion === 'pending') return { kind: 'deletion-pending' }
      if (!fencedAccount) return { kind: 'deletion-pending' }
      return { kind: 'deleted' }
    } catch {
      return { kind: 'deletion-pending' }
    }
  }

  private assertOpen() {
    if (this.#generationInvalid) throw new StaleAccountGenerationError()
    if (this.#closed) throw new Error('LocalFeed is closed')
  }

  private async assertGeneration() {
    if (!(await this.generations.isCurrent(this.owner))) {
      throw new StaleAccountGenerationError()
    }
  }

  private async handleLocalChange(scope: 'data' | 'status' = 'data') {
    if (scope === 'data') this.scheduleProjectionMaintenance()
    else if (
      this.database.volatileSyncStatus?.kind === 'attention' &&
      this.database.volatileSyncStatus.issue === 'storage-full'
    ) {
      this.scheduleProjectionMaintenance(60_000)
    }
    await this.refreshProjections(scope)
  }

  private async refreshProjections(scope: 'data' | 'status') {
    const refreshes: Promise<void>[] = []
    for (const projection of this.#projections) {
      if (projection.dependsOn(scope)) refreshes.push(projection.refresh())
    }
    await Promise.all(refreshes)
  }

  private scheduleProjectionMaintenance(delayMs = 16) {
    if (this.#closed || this.#generationInvalid || this.#maintenanceTimer !== undefined) return
    if (this.#maintenanceRunning) {
      this.#maintenanceRequested = true
      return
    }
    this.#maintenanceTimer = setTimeout(() => {
      this.#maintenanceTimer = undefined
      const running = this.runProjectionMaintenance()
      this.#maintenancePromise = running
      void running.finally(() => {
        if (this.#maintenancePromise === running) this.#maintenancePromise = null
      })
    }, delayMs)
  }

  private async runProjectionMaintenance() {
    if (this.#closed || this.#generationInvalid || this.#maintenanceRunning) {
      return
    }
    if (
      !(await this.generations.isCurrent(this.owner)) ||
      this.#closed ||
      this.#generationInvalid
    ) {
      return
    }
    this.#maintenanceRunning = true
    this.#maintenanceRequested = false
    let more = false
    let retryDelay: number | null = null
    try {
      const result = await maintainActivityProjection(
        this.database,
        this.#sanitizer,
        250,
        this.owner,
      )
      this.#maintenanceFailures = 0
      let recoveredStorage = false
      if (
        this.database.volatileSyncStatus?.kind === 'attention' &&
        this.database.volatileSyncStatus.issue === 'storage-full'
      ) {
        this.database.volatileSyncStatus = undefined
        recoveredStorage = true
        await this.refreshProjections('status')
      }
      more = result.more
      if (result.visibleChanged && !this.#closed) {
        this.tabs.announce({ kind: 'projection-changed' })
        await this.refreshProjections('data')
      }
      if (
        !this.#closed &&
        projectionMaintenanceRequestsSync({ promoted: result.promoted, recoveredStorage })
      ) {
        this.#sync.requestSync()
      }
    } catch (error) {
      if (isStorageQuotaError(error)) {
        this.#maintenanceFailures = 0
        more = true
        retryDelay = 60_000
        const [pendingUserOperations, status] = await Promise.all([
          this.database.outbox
            .where('status')
            .equals('pending')
            .count()
            .catch(() => 0),
          this.database.syncState.get('status').catch(() => undefined),
        ])
        this.database.volatileSyncStatus = {
          kind: 'attention',
          issue: 'storage-full',
          pendingUserOperations,
          ...(status?.lastCloudContactAt === undefined
            ? {}
            : { lastCloudContactAt: status.lastCloudContactAt }),
        }
        await this.refreshProjections('status').catch(() => undefined)
      } else {
        const current = await this.generations.isCurrent(this.owner).catch(() => false)
        if (current && !this.#closed && !this.#generationInvalid) {
          this.#maintenanceFailures += 1
          retryDelay = projectionMaintenanceRetryDelay(this.#maintenanceFailures)
          more = true
        }
      }
    } finally {
      this.#maintenanceRunning = false
      if ((more || this.#maintenanceRequested) && !this.#closed) {
        this.scheduleProjectionMaintenance(retryDelay ?? 16)
      }
    }
  }
}

export async function openLocalFeed(options: OpenLocalFeedOptions): Promise<LocalFeed> {
  const existing = await options.generations.read(options.ownerGithubId)
  const owner = existing ?? (await options.generations.initialize(options.ownerGithubId))
  const active = await options.generations.readActive()
  if (
    owner.state !== 'active' ||
    active?.ownerGithubId !== owner.ownerGithubId ||
    active.generation !== owner.generation ||
    active.nonce !== owner.nonce ||
    !(await options.generations.isCurrent(owner))
  ) {
    throw new StaleAccountGenerationError()
  }

  const database = new LocalFeedDatabase(databaseNameForOwner(options.ownerGithubId))
  let created: boolean
  try {
    created = await initializeDatabase(
      database,
      options.ownerGithubId,
      owner.generation,
      owner.nonce,
    )
  } catch (error) {
    database.close({ disableAutoOpen: true })
    throw error
  }
  if (!(await options.generations.isCurrent(owner))) {
    database.close({ disableAutoOpen: true })
    const current = await options.generations.read(options.ownerGithubId)
    if (created && (current?.state === 'deleting' || current?.state === 'signed-out')) {
      await runBoundedDatabaseDelete(() => database.delete())
    }
    throw new StaleAccountGenerationError()
  }

  const tabs =
    options.tabs ??
    (typeof window === 'undefined'
      ? createSingleTabCoordinator()
      : createDexieTabCoordinator(
          database,
          `better-github-feed:local-feed:${options.ownerGithubId}`,
          { now: options.now },
        ))
  const lifecycle =
    options.lifecycle ??
    (typeof window === 'undefined'
      ? createManualSyncLifecyclePort({ online: options.cloud !== undefined })
      : createBrowserSyncLifecyclePort())
  const feed = new DexieLocalFeed(database, owner, options.generations, tabs, lifecycle, options)
  feed.start()
  if (typeof navigator !== 'undefined') {
    void feed.requestStoragePersistence(
      options.storagePersistence ?? createBrowserStoragePersistencePort(),
    )
  }
  return feed
}

export async function activateVerifiedLocalAccount(
  generations: AccountGenerationPort,
  verifiedOwnerGithubId: string,
  proof: { expectedActive: AccountGeneration | null; explicitAuthIntent: boolean },
): Promise<AccountGeneration> {
  const activation = await generations.activateVerified(verifiedOwnerGithubId, proof)
  if (typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined') {
    for (const account of activation.changedAccounts) {
      const channel = new BroadcastChannel(`better-github-feed:local-feed:${account.ownerGithubId}`)
      channel.postMessage({
        kind: 'account-generation',
        generation: account.generation,
        nonce: account.nonce,
      })
      channel.close()
    }
  }
  return activation.account
}
