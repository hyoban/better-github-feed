import type { Database } from '@better-github-feed/db'
import {
  activityChange,
  activityRetentionState,
  feedItem,
  localFeedServerState,
} from '@better-github-feed/db/schema/github'
import { and, eq, sql } from 'drizzle-orm'

export type ActivityIntegrityAudit = {
  ready: boolean
  unnormalizedItems: number
  itemsWithoutChange: number
  mismatchedChanges: number
  orphanChanges: number
  actorsWithoutRetention: number
}

export async function getLocalFeedDataEpoch(database: Database, override?: string) {
  if (override) {
    return override
  }

  const read = () =>
    database
      .select({ dataEpoch: localFeedServerState.dataEpoch })
      .from(localFeedServerState)
      .where(eq(localFeedServerState.id, 1))
      .limit(1)
  const current = await read()
  if (current[0]) {
    return current[0].dataEpoch
  }

  await database
    .insert(localFeedServerState)
    .values({ id: 1, dataEpoch: `local-feed-v1-${crypto.randomUUID()}` })
    .onConflictDoNothing()
  const inserted = await read()
  if (!inserted[0]) {
    throw new Error('Local Feed server state is unavailable')
  }
  return inserted[0].dataEpoch
}

export async function auditActivitySyncIntegrity(
  database: Database,
): Promise<ActivityIntegrityAudit> {
  const [
    unnormalizedRows,
    missingChangeRows,
    mismatchedRows,
    orphanChangeRows,
    missingRetentionRows,
  ] = await Promise.all([
    database
      .select({ count: sql<number>`count(*)` })
      .from(feedItem)
      .where(eq(feedItem.actorKey, '')),
    database.select({ count: sql<number>`count(*)` }).from(feedItem).where(sql`
          not exists (
            select 1 from ${activityChange}
            where ${activityChange.source} = ${feedItem.source}
              and ${activityChange.activityId} = ${feedItem.id}
          )
        `),
    database.select({ count: sql<number>`count(*)` }).from(activityChange).where(sql`
          exists (
            select 1 from ${feedItem}
            where ${feedItem.source} = ${activityChange.source}
              and ${feedItem.id} = ${activityChange.activityId}
              and (
                ${feedItem.actorKey} <> ${activityChange.actorKey}
                or coalesce(${feedItem.actorGithubId}, '')
                  <> coalesce(${activityChange.actorGithubId}, '')
              )
          )
        `),
    database.select({ count: sql<number>`count(*)` }).from(activityChange).where(sql`
          not exists (
            select 1 from ${feedItem}
            where ${feedItem.source} = ${activityChange.source}
              and ${feedItem.id} = ${activityChange.activityId}
          )
        `),
    database.select({ count: sql<number>`count(distinct ${feedItem.actorKey})` }).from(feedItem)
      .where(sql`
          ${feedItem.actorKey} <> ''
          and not exists (
            select 1 from ${activityRetentionState}
            where ${activityRetentionState.actorKey} = ${feedItem.actorKey}
          )
        `),
  ])

  const audit = {
    unnormalizedItems: Number(unnormalizedRows[0]?.count ?? 0),
    itemsWithoutChange: Number(missingChangeRows[0]?.count ?? 0),
    mismatchedChanges: Number(mismatchedRows[0]?.count ?? 0),
    orphanChanges: Number(orphanChangeRows[0]?.count ?? 0),
    actorsWithoutRetention: Number(missingRetentionRows[0]?.count ?? 0),
  }
  return { ...audit, ready: Object.values(audit).every(count => count === 0) }
}

export async function markActivityReconciled(
  database: Database,
  reconciledAt: Date,
  options: { beforeEnable?: () => Promise<void> } = {},
) {
  const expectedDataEpoch = await getLocalFeedDataEpoch(database)
  // Capture the epoch before auditing so a concurrent rotation cannot inherit an older proof.
  // oxlint-disable-next-line react-doctor/server-sequential-independent-await
  const audit = await auditActivitySyncIntegrity(database)
  if (!audit.ready) {
    return audit
  }
  await options.beforeEnable?.()
  const result = await database
    .update(localFeedServerState)
    .set({ activityReconciledAt: reconciledAt, activityCleanupEnabledAt: reconciledAt })
    .where(
      and(eq(localFeedServerState.id, 1), eq(localFeedServerState.dataEpoch, expectedDataEpoch)),
    )
  return result.meta.changes > 0 ? audit : { ...audit, ready: false }
}

export async function getActivityCleanupGate(database: Database) {
  const rows = await database
    .select({
      dataEpoch: localFeedServerState.dataEpoch,
      reconciledAt: localFeedServerState.activityReconciledAt,
      enabledAt: localFeedServerState.activityCleanupEnabledAt,
    })
    .from(localFeedServerState)
    .where(eq(localFeedServerState.id, 1))
    .limit(1)
  const state = rows[0]
  if (!state || !state.reconciledAt || !state.enabledAt) {
    return {
      enabled: false as const,
      reason: 'rollout-gate' as const,
      dataEpoch: state?.dataEpoch ?? null,
    }
  }
  const audit = await auditActivitySyncIntegrity(database)
  return audit.ready
    ? { enabled: true as const, dataEpoch: state.dataEpoch, audit }
    : {
        enabled: false as const,
        reason: 'integrity-audit' as const,
        dataEpoch: state.dataEpoch,
        audit,
      }
}
