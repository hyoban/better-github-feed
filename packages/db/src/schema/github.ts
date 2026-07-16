import { sql } from 'drizzle-orm'
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

// Global GitHub user table - stores users found through GitHub following sync
// Primary key is the GitHub login (username)
export const githubUser = sqliteTable(
  'github_user',
  {
    login: text('login').primaryKey(),
    id: text('id'), // GitHub user ID (e.g., "38493346"), optional
    lastRefreshedAt: integer('last_refreshed_at', { mode: 'timestamp_ms' }),
    refreshClaimedAt: integer('refresh_claimed_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  table => [index('github_user_id_idx').on(table.id)],
)

// Global feed item table - stores activity items for GitHub users
export const feedItem = sqliteTable(
  'feed_item',
  {
    id: text('id').primaryKey(),
    githubUserLogin: text('github_user_login').notNull(),
    actorKey: text('actor_key').default('').notNull(),
    actorGithubId: text('actor_github_id'),
    source: text('source').default('github-atom-v1').notNull(),
    title: text('title').notNull(),
    link: text('link'),
    repo: text('repo'),
    type: text('type').notNull(),
    summary: text('summary'),
    content: text('content'),
    hidden: integer('hidden', { mode: 'boolean' }).default(false).notNull(),
    publishedAt: integer('published_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  table => [
    index('feed_item_github_user_login_idx').on(table.githubUserLogin),
    index('feed_item_github_user_login_published_at_idx').on(
      table.githubUserLogin,
      table.publishedAt,
    ),
    index('feed_item_actor_key_published_at_id_idx').on(
      table.actorKey,
      table.publishedAt,
      table.id,
    ),
    // 支持纯时间排序的游标分页
    index('feed_item_published_at_idx').on(table.publishedAt),
    // 支持类型过滤 + 时间排序
    index('feed_item_type_published_at_idx').on(table.type, table.publishedAt),
  ],
)

// Append-only ingestion sequence for browser delta synchronization. Rows are
// compacted alongside the bounded D1 feed, but sequence allocation never moves
// backwards and browser clients never interpret compaction as a deletion.
export const activityChange = sqliteTable(
  'activity_change',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    source: text('source').default('github-atom-v1').notNull(),
    activityId: text('activity_id').notNull(),
    actorKey: text('actor_key').notNull(),
    actorGithubId: text('actor_github_id'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  table => [
    uniqueIndex('activity_change_source_activity_idx').on(table.source, table.activityId),
    index('activity_change_actor_seq_idx').on(table.actorKey, table.seq),
  ],
)

export const activitySyncState = sqliteTable('activity_sync_state', {
  id: integer('id').primaryKey(),
  headSeq: integer('head_seq').default(0).notNull(),
  retentionGeneration: integer('retention_generation').default(0).notNull(),
})

// Persistent server-side generation and rollout fences for Local Feed Sync.
// Rotating dataEpoch invalidates remote cursors/control state without coupling
// the dataset identity to a Worker build. Cleanup remains disabled until the
// new Worker completes a successful reconciliation audit.
export const localFeedServerState = sqliteTable('local_feed_server_state', {
  id: integer('id').primaryKey(),
  dataEpoch: text('data_epoch').notNull(),
  activityReconciledAt: integer('activity_reconciled_at', { mode: 'timestamp_ms' }),
  activityCleanupEnabledAt: integer('activity_cleanup_enabled_at', { mode: 'timestamp_ms' }),
})

export const activityRetentionState = sqliteTable('activity_retention_state', {
  actorKey: text('actor_key').primaryKey(),
  compactedThroughSeq: integer('compacted_through_seq').default(0).notNull(),
  retentionGeneration: integer('retention_generation').default(0).notNull(),
  oldestRetainedPublishedAt: integer('oldest_retained_published_at', {
    mode: 'timestamp_ms',
  }),
  oldestRetainedActivityId: text('oldest_retained_activity_id'),
})

// Materialized relation between app users and their GitHub following lists
export const subscription = sqliteTable(
  'subscription',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    githubUserLogin: text('github_user_login').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  table => [
    index('subscription_user_id_idx').on(table.userId),
    index('subscription_github_user_login_idx').on(table.githubUserLogin),
    uniqueIndex('subscription_user_github_user_idx').on(table.userId, table.githubUserLogin),
  ],
)

export const followingSnapshot = sqliteTable(
  'following_snapshot',
  {
    revision: text('revision').primaryKey(),
    userId: text('user_id').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    completedAt: integer('completed_at', { mode: 'timestamp_ms' }).notNull(),
  },
  table => [index('following_snapshot_user_completed_idx').on(table.userId, table.completedAt)],
)

export const followingMember = sqliteTable(
  'following_member',
  {
    revision: text('revision').notNull(),
    actorKey: text('actor_key').notNull(),
    githubId: text('github_id').notNull(),
    login: text('login').notNull(),
    legacyActorKeys: text('legacy_actor_keys').default('[]').notNull(),
    position: integer('position').notNull(),
  },
  table => [
    primaryKey({ columns: [table.revision, table.actorKey] }),
    uniqueIndex('following_member_revision_position_idx').on(table.revision, table.position),
    index('following_member_revision_login_idx').on(table.revision, table.login),
  ],
)

export const followingSyncState = sqliteTable('following_sync_state', {
  userId: text('user_id').primaryKey(),
  activeRevision: text('active_revision'),
  previousRevision: text('previous_revision'),
  completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
  reauthRequiredAt: integer('reauth_required_at', { mode: 'timestamp_ms' }),
  claimToken: text('claim_token'),
  claimClaimedAt: integer('claim_claimed_at', { mode: 'timestamp_ms' }),
})

// User-owned feed view state, kept separate from replaceable GitHub Following snapshots
export const userFeedState = sqliteTable('user_feed_state', {
  userId: text('user_id').primaryKey(),
  activityClearedAt: integer('activity_cleared_at', { mode: 'timestamp_ms' }).notNull(),
  entityVersion: integer('entity_version').default(0).notNull(),
  changedRevision: integer('changed_revision').default(0).notNull(),
  lastAttemptId: text('last_attempt_id'),
})

// User filter rules table - stores custom filter rules for each user
export const userFilter = sqliteTable(
  'user_filter',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    name: text('name').notNull(),
    filterRule: text('filter_rule').notNull(), // Serialized FilterGroup JSON
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    entityVersion: integer('entity_version').default(1).notNull(),
    changedRevision: integer('changed_revision').default(0).notNull(),
    deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
    lastAttemptId: text('last_attempt_id'),
  },
  table => [index('user_filter_user_id_idx').on(table.userId)],
)

export const userStateSyncState = sqliteTable('user_state_sync_state', {
  userId: text('user_id').primaryKey(),
  headSeq: integer('head_seq').default(0).notNull(),
  compactedThroughSeq: integer('compacted_through_seq').default(0).notNull(),
  epoch: text('epoch').notNull(),
})

export const userStateChange = sqliteTable(
  'user_state_change',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    userId: text('user_id').notNull(),
    entityKind: text('entity_kind', { enum: ['filter', 'feed-state'] }).notNull(),
    entityId: text('entity_id').notNull(),
    entityVersion: integer('entity_version').notNull(),
    changedAt: integer('changed_at', { mode: 'timestamp_ms' }).notNull(),
  },
  table => [index('user_state_change_user_seq_idx').on(table.userId, table.seq)],
)

export const userMutationReceipt = sqliteTable(
  'user_mutation_receipt',
  {
    userId: text('user_id').notNull(),
    attemptId: text('attempt_id').notNull(),
    mutationId: text('mutation_id').notNull(),
    entityKind: text('entity_kind', { enum: ['filter', 'feed-state'] }).notNull(),
    entityId: text('entity_id').notNull(),
    result: text('result').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  table => [
    primaryKey({ columns: [table.userId, table.attemptId] }),
    index('user_mutation_receipt_user_mutation_idx').on(table.userId, table.mutationId),
  ],
)
