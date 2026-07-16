import type { FilterGroup } from '@better-github-feed/shared'

export type NonEmpty<T> = readonly [T, ...T[]]

export type FeedView = {
  actors: 'following' | NonEmpty<string>
  types: 'all' | NonEmpty<string>
}

export type CoverageFacts = {
  bootstrap: 'never-synced' | 'initialized'
  demand: 'satisfied' | 'insufficient'
  hasMoreLocal: boolean
  remoteWindow: 'unchecked' | 'may-have-more' | 'exhausted'
  integrity: 'continuous' | 'gap-detected'
}

export type ActorSummary = {
  actorKey: string
  githubId: string | null
  login: string
  avatarUrl: string | null
}

export type FollowingSummary = ActorSummary & {
  followedAt: number
  itemCount: number
  latestEntryAt: number | null
}

export type FollowingWindow = {
  items: readonly FollowingSummary[]
  totalLocal: number
  coverage: CoverageFacts
  computation: 'ready' | 'rebuilding'
}

export type ActivitySummary = {
  id: string
  actorKey: string
  actor: string
  actorGithubId: string | null
  actorAvatarUrl: string | null
  title: string
  link: string | null
  repo: string | null
  type: string
  publishedAt: number
  summary: string | null
  source: 'github-atom-v1'
}

export type RawAtomActivity = ActivitySummary & {
  actorGithubId: string | null
  actorAvatarUrl: string | null
  content: string | null
}

export type VisibleFeedWindow = {
  items: readonly ActivitySummary[]
  coverage: CoverageFacts
  rejectedActorKeys: readonly string[]
  computation: 'ready' | 'rebuilding'
}

export type ActivityResult =
  | { kind: 'available'; activity: RawAtomActivity }
  | { kind: 'resolving' }
  | { kind: 'unavailable-offline' }
  | { kind: 'cloud-unavailable' }
  | { kind: 'not-authorized' }
  | { kind: 'cloud-miss'; reason: 'not-retained-or-unknown' }

type LocalUserFilterBase = {
  id: string
  name: string
  sync: 'synced' | 'pending' | 'conflict-copy'
}

export type LocalUserFilter =
  | (LocalUserFilterBase & { isValid: true; rule: FilterGroup })
  | (LocalUserFilterBase & {
      isValid: false
      rule: null
      issue: 'invalid-legacy-rule'
    })

export type EditableUserFilter = {
  id?: string
  name: string
  rule: FilterGroup
}

export type LocalFeedStatistics = {
  typeCounts: Readonly<Record<string, number>>
  coverage: 'complete-for-demand' | 'partial'
  computation: 'ready' | 'rebuilding'
}

export type LocalSyncStatusBase = {
  lastCloudContactAt?: number
  pendingUserOperations: number
}

export type LocalSyncStatus =
  | (LocalSyncStatusBase & { kind: 'quiet' })
  | (LocalSyncStatusBase & {
      kind: 'working'
      phase: 'control' | 'following' | 'activity' | 'user-state'
    })
  | (LocalSyncStatusBase & { kind: 'offline'; hasUnmetDemand: boolean })
  | (LocalSyncStatusBase & {
      kind: 'degraded'
      issue: 'cloud-unavailable'
      retryAt?: number
    })
  | (LocalSyncStatusBase & {
      kind: 'attention'
      issue: 'reauth-required' | 'account-mismatch' | 'storage-full'
    })

export type ProjectionMap = {
  following: {
    input: { sort: 'latest' | 'name'; first: number }
    output: FollowingWindow
  }
  'visible-feed': {
    input: { view: FeedView; first: number }
    output: VisibleFeedWindow
  }
  activity: {
    input: { id: string }
    output: ActivityResult
  }
  'user-filters': {
    input: Record<never, never>
    output: readonly LocalUserFilter[]
  }
  statistics: {
    input: { actors: FeedView['actors'] }
    output: LocalFeedStatistics
  }
  'sync-status': {
    input: Record<never, never>
    output: LocalSyncStatus
  }
}

export type Projection = {
  [K in keyof ProjectionMap]: { kind: K } & ProjectionMap[K]['input']
}[keyof ProjectionMap]

export type ProjectionOutput<P extends Projection> = ProjectionMap[P['kind']]['output']

export type LocalCommand =
  | { kind: 'filter.put'; filter: EditableUserFilter }
  | { kind: 'filter.delete'; id: string }
  | { kind: 'feed.clear' }

export type CommitReceipt = {
  localRevision: number
  mutationId: string
  sync: 'queued'
}

export type ProjectionSnapshot<T> =
  | { kind: 'opening-local' }
  | { kind: 'ready'; localRevision: number; value: T }
  | { kind: 'failed'; issue: 'local-query-failed'; error: Error }

export interface LiveProjection<T> {
  getSnapshot(): ProjectionSnapshot<T>
  subscribe(listener: () => void): () => void
  dispose(): void
}

export type CloseReason =
  | { kind: 'shutdown' }
  | { kind: 'account-switch' }
  | { kind: 'sign-out'; localData?: 'delete' | 'retain-locked' }

export type CloseResult =
  | { kind: 'closed' }
  | { kind: 'deleted' }
  | { kind: 'retained-locked' }
  | { kind: 'deletion-pending' }

export interface LocalFeed {
  observe<P extends Projection>(projection: P): LiveProjection<ProjectionOutput<P>>
  commit(command: LocalCommand): Promise<CommitReceipt>
  close(reason: CloseReason): Promise<CloseResult>
}

export type LocalFeedBootState =
  | { kind: 'opening-database' }
  | { kind: 'deleting-local-data'; ownerGithubId: string }
  | { kind: 'locked-awaiting-auth'; ownerGithubId: string }
  | { kind: 'ready'; feed: LocalFeed }
  | {
      kind: 'failed'
      issue: 'migration-failed' | 'database-unavailable'
      error: Error
    }
