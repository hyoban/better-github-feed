import type { FilterGroup } from '@better-github-feed/shared'

export type RemoteAtomActivity = {
  id: string
  source: 'github-atom-v1'
  actorKey: string
  actorGithubId: string | null
  actorLogin: string
  title: string
  link: string | null
  repo: string | null
  type: string
  publishedAt: string
  publishedAtMs: number
  summary: string | null
  content: string | null
}

export interface ActivitySanitizerPort {
  readonly version: string
  sanitizeHtml(html: string): string
}

export type ReplicaScope =
  | { scopeKind: 'following'; followingRevision: string }
  | { scopeKind: 'actors'; actorKeys: readonly [string, ...string[]] }

export type RevisionManifest = {
  protocol: 1
  serverEpoch: string
  viewerGithubId: string
  serverTime: number
  timeAnchor: string
  activity: {
    headSeq: string
    retentionGeneration: string
  }
  following: {
    revision: string | null
    completedAt: number | null
    reauthRequiredAt: number | null
  }
  userState: {
    revision: string
    epoch: string
  }
  bookmark?: string
  etag?: string
}

export type FollowingReplica = {
  actorKey: string
  githubId: string
  login: string
  avatarUrl?: string | null
  followedAt?: number
  legacyActorKeys: readonly string[]
}

export type FollowingPage = {
  viewerGithubId: string
  revision: string
  items: readonly FollowingReplica[]
  nextCursor: string | null
}

export type ActivityHistoryPage = {
  viewerGithubId: string
  scopeKey: string
  throughSeq: string
  retentionFingerprint: string
  items: readonly RemoteAtomActivity[]
  nextCursor: string | null
  remoteWindowEnd: boolean
}

export type ActivityDeltaPage = {
  viewerGithubId: string
  scopeKey: string
  throughSeq: string
  retentionFingerprint: string
  gap: null | { compactedThroughSeq: string }
  items: readonly RemoteAtomActivity[]
  nextCursor: string | null
}

export type FilterReplica = {
  id: string
  version: number
  changedRevision: string
  deletedAt: number | null
  value:
    | { name: string; isValid: true; rule: FilterGroup }
    | { name: string; isValid: false; invalidLegacyRule?: unknown }
    | null
}

export type FeedStateReplica = {
  version: number
  changedRevision: string
  clearedAt: number | null
}

export type UserStatePage = {
  viewerGithubId: string
  mode: 'delta' | 'snapshot'
  revision: string
  epoch: string
  compactedThroughSeq: string
  filters: readonly FilterReplica[]
  feedState: FeedStateReplica | null
  nextCursor: string | null
}

export type FilterPutMutation = {
  kind: 'filter.put'
  mutationId: string
  attemptId: string
  baseVersion: number
  filter: { id: string; name: string; rule: FilterGroup }
}

export type FilterDeleteMutation = {
  kind: 'filter.delete'
  mutationId: string
  attemptId: string
  baseVersion: number
  id: string
}

export type FeedClearMutation = {
  kind: 'feed.clear'
  mutationId: string
  attemptId: string
  baseVersion: number
  candidate: number | null
  timeAnchor: string | null
}

export type UserStateMutation = FilterPutMutation | FilterDeleteMutation | FeedClearMutation

export type UserMutationResult =
  | {
      viewerGithubId: string
      kind: 'applied' | 'already-applied'
      revision: string
      filter?: FilterReplica
      feedState?: FeedStateReplica
    }
  | {
      viewerGithubId: string
      kind: 'conflict'
      filter?: FilterReplica
      feedState?: FeedStateReplica
    }

export interface CloudReplicaPort {
  getManifest(input: { etag?: string; bookmark?: string }): Promise<
    | {
        kind: 'not-modified'
        viewerGithubId: string
        etag: string
        bookmark: string | null
      }
    | {
        kind: 'manifest'
        manifest: RevisionManifest
        etag: string
        bookmark: string | null
      }
  >

  getFollowingPage(input: {
    revision: string
    cursor?: string
    limit?: number
    bookmark?: string
  }): Promise<FollowingPage>

  getActivityHistoryPage(
    input: ReplicaScope & {
      cursor?: string
      limit?: number
      targetThroughSeq?: string
      bookmark?: string
    },
  ): Promise<ActivityHistoryPage>

  getActivityDeltaPage(
    input: ReplicaScope & {
      fromSeq: string
      cursor?: string
      limit?: number
      targetThroughSeq?: string
      bookmark?: string
    },
  ): Promise<ActivityDeltaPage>

  getActivityById(input: { id: string; bookmark?: string }): Promise<{
    viewerGithubId: string
    result:
      | { kind: 'found'; activity: RemoteAtomActivity }
      | { kind: 'not-authorized' }
      | { kind: 'cloud-miss' }
  }>

  pullUserState(input: {
    afterSeq?: string
    epoch?: string
    limit?: number
    bookmark?: string
  }): Promise<UserStatePage>

  pushUserMutation(input: {
    mutation: UserStateMutation
    bookmark?: string
  }): Promise<UserMutationResult>
}

export class CloudReplicaError extends Error {
  constructor(
    public readonly code:
      | 'OFFLINE'
      | 'REAUTH_REQUIRED'
      | 'RATE_LIMITED'
      | 'SNAPSHOT_EXPIRED'
      | 'RETENTION_CHANGED'
      | 'SCOPE_NOT_AUTHORIZED'
      | 'UNAVAILABLE',
    message: string = code,
    public readonly retryAt?: number,
  ) {
    super(message)
    this.name = 'CloudReplicaError'
  }
}
