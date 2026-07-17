import type { Database } from '@better-github-feed/db'
import {
  activityChange,
  activityRetentionState,
  activitySyncState,
  feedItem,
  githubUser,
  localFeedServerState,
} from '@better-github-feed/db/schema/github'
import { eq, sql } from 'drizzle-orm'

import { markActivityReconciled } from './activity-rollout'

const reconciliationProofMaxAgeMs = 24 * 60 * 60 * 1000

export function createActivityReconciliation(database: Database) {
  const reconciliation = {
    async reconcile(reconciledAt = new Date()) {
      // Close the cleanup fence before refreshing its proof. A failed or
      // interrupted reconciliation must not leave an older proof active.
      await database
        .update(localFeedServerState)
        .set({ activityReconciledAt: null, activityCleanupEnabledAt: null })
        .where(eq(localFeedServerState.id, 1))
      const results = await database.batch([
        database
          .update(feedItem)
          .set({
            actorGithubId: sql`(
              select ${githubUser.id}
              from ${githubUser}
              where ${githubUser.login} = ${feedItem.githubUserLogin}
            )`,
            actorKey: sql`case
              when (
                select ${githubUser.id}
                from ${githubUser}
                where ${githubUser.login} = ${feedItem.githubUserLogin}
              ) is not null
              then 'github:' || (
                select ${githubUser.id}
                from ${githubUser}
                where ${githubUser.login} = ${feedItem.githubUserLogin}
              )
              else 'legacy-atom-login:' || lower(${feedItem.githubUserLogin})
            end`,
          })
          .where(eq(feedItem.actorKey, '')),
        database.update(activityChange).set({
          actorKey: sql`(
              select ${feedItem.actorKey}
              from ${feedItem}
              where ${feedItem.source} = ${activityChange.source}
                and ${feedItem.id} = ${activityChange.activityId}
            )`,
          actorGithubId: sql`(
              select ${feedItem.actorGithubId}
              from ${feedItem}
              where ${feedItem.source} = ${activityChange.source}
                and ${feedItem.id} = ${activityChange.activityId}
            )`,
        }).where(sql`
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
        database
          .insert(activityChange)
          .select(sql`
            select
              null,
              ${feedItem.source},
              ${feedItem.id},
              ${feedItem.actorKey},
              ${feedItem.actorGithubId},
              ${feedItem.createdAt}
            from ${feedItem}
            where ${feedItem.actorKey} <> ''
              and not exists (
                select 1 from ${activityChange}
                where ${activityChange.source} = ${feedItem.source}
                  and ${activityChange.activityId} = ${feedItem.id}
            )
            order by ${feedItem.createdAt} asc, ${feedItem.id} asc
          `)
          .onConflictDoNothing(),
        database
          .insert(activityRetentionState)
          .select(sql`
            select
              ${feedItem.actorKey},
              0,
              0,
              min(${feedItem.publishedAt}),
              (
                select oldest.id
                from feed_item as oldest
                where oldest.actor_key = ${feedItem.actorKey}
                order by oldest.published_at asc, oldest.id asc
                limit 1
              )
            from ${feedItem}
            where ${feedItem.actorKey} <> ''
            group by ${feedItem.actorKey}
          `)
          .onConflictDoUpdate({
            target: activityRetentionState.actorKey,
            set: {
              oldestRetainedPublishedAt: sql`excluded.oldest_retained_published_at`,
              oldestRetainedActivityId: sql`excluded.oldest_retained_activity_id`,
            },
          }),
        database
          .insert(activityRetentionState)
          .select(sql`
            select
              ${activityChange.actorKey},
              max(${activityChange.seq}),
              1,
              (
                select oldest.published_at
                from feed_item as oldest
                where oldest.actor_key = ${activityChange.actorKey}
                order by oldest.published_at asc, oldest.id asc
                limit 1
              ),
              (
                select oldest.id
                from feed_item as oldest
                where oldest.actor_key = ${activityChange.actorKey}
                order by oldest.published_at asc, oldest.id asc
                limit 1
              )
            from ${activityChange}
            where ${activityChange.actorKey} <> ''
              and not exists (
                select 1 from ${feedItem}
                where ${feedItem.source} = ${activityChange.source}
                  and ${feedItem.id} = ${activityChange.activityId}
              )
            group by ${activityChange.actorKey}
          `)
          .onConflictDoUpdate({
            target: activityRetentionState.actorKey,
            set: {
              compactedThroughSeq: sql`max(
                ${activityRetentionState.compactedThroughSeq},
                excluded.compacted_through_seq
              )`,
              retentionGeneration: sql`${activityRetentionState.retentionGeneration} + 1`,
              oldestRetainedPublishedAt: sql`excluded.oldest_retained_published_at`,
              oldestRetainedActivityId: sql`excluded.oldest_retained_activity_id`,
            },
          }),
        database.update(activitySyncState).set({
          retentionGeneration: sql`${activitySyncState.retentionGeneration} + 1`,
        }).where(sql`
            ${activitySyncState.id} = 1
            and exists (
              select 1 from ${activityChange}
              where ${activityChange.actorKey} <> ''
                and not exists (
                  select 1 from ${feedItem}
                  where ${feedItem.source} = ${activityChange.source}
                    and ${feedItem.id} = ${activityChange.activityId}
                )
            )
          `),
        database.delete(activityChange).where(sql`
          ${activityChange.actorKey} <> ''
          and not exists (
            select 1 from ${feedItem}
            where ${feedItem.source} = ${activityChange.source}
              and ${feedItem.id} = ${activityChange.activityId}
          )
        `),
      ])
      // The integrity audit must observe the reconciliation batch above.
      // oxlint-disable-next-line react-doctor/server-sequential-independent-await
      const audit = await markActivityReconciled(database, reconciledAt)
      return {
        normalized: results[0].meta.changes,
        repairedChanges: results[1].meta.changes,
        sequenced: results[2].meta.changes,
        repairedOrphanChanges: results[6].meta.changes,
        audit,
      }
    },
    async reconcileIfNeeded(reconciledAt = new Date()) {
      const rows = await database
        .select({
          reconciledAt: localFeedServerState.activityReconciledAt,
          cleanupEnabledAt: localFeedServerState.activityCleanupEnabledAt,
        })
        .from(localFeedServerState)
        .where(eq(localFeedServerState.id, 1))
        .limit(1)
      const proof = rows[0]
      if (
        proof?.reconciledAt &&
        proof.cleanupEnabledAt &&
        proof.reconciledAt.getTime() >= reconciledAt.getTime() - reconciliationProofMaxAgeMs
      ) {
        return {
          normalized: 0,
          repairedChanges: 0,
          sequenced: 0,
          repairedOrphanChanges: 0,
          skipped: 'recent-proof' as const,
          audit: { ready: true as const },
        }
      }
      return reconciliation.reconcile(reconciledAt)
    },
  }
  return reconciliation
}
