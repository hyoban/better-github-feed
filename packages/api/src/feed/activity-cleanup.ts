import type { Database } from '@better-github-feed/db'
import {
  activityChange,
  activityRetentionState,
  activitySyncState,
  feedItem,
  localFeedServerState,
} from '@better-github-feed/db/schema/github'
import { and, asc, eq, isNotNull, ne, sql } from 'drizzle-orm'

import { getActivityCleanupGate } from './activity-rollout'

export function createActivityCleanup(database: Database) {
  return {
    async cleanup(maxItemsPerActor = 200) {
      if (!Number.isSafeInteger(maxItemsPerActor) || maxItemsPerActor < 1) {
        throw new RangeError('Activity retention count must be a positive integer')
      }
      const gate = await getActivityCleanupGate(database)
      if (!gate.enabled) {
        return { deleted: 0, skipped: gate.reason, dataEpoch: gate.dataEpoch }
      }
      const gateStillOpen = sql`exists (
        select 1 from ${localFeedServerState}
        where ${localFeedServerState.id} = 1
          and ${localFeedServerState.dataEpoch} = ${gate.dataEpoch}
          and ${localFeedServerState.activityReconciledAt} is not null
          and ${localFeedServerState.activityCleanupEnabledAt} is not null
      )`
      const actors = await database
        .select({ actorKey: feedItem.actorKey })
        .from(feedItem)
        .where(ne(feedItem.actorKey, ''))
        .groupBy(feedItem.actorKey)
        .having(sql`count(*) > ${maxItemsPerActor}`)
        .orderBy(asc(feedItem.actorKey))
      let totalDeleted = 0

      for (const actor of actors) {
        const cleanupCandidates = sql`
          select ${feedItem.id}
          from ${feedItem}
          where ${feedItem.actorKey} = ${actor.actorKey}
          order by ${feedItem.publishedAt} desc, ${feedItem.id} desc
          limit -1 offset ${maxItemsPerActor}
        `
        const hasCleanupCandidates = sql`exists (${cleanupCandidates})`
        const removedMaxSeq = sql<number>`coalesce((
          select max(${activityChange.seq})
          from ${activityChange}
          where ${activityChange.source} = 'github-atom-v1'
            and ${activityChange.activityId} in (${cleanupCandidates})
        ), 0)`

        // Actor cleanup is serialized, while each actor's selection and writes stay atomic.
        // oxlint-disable-next-line react-doctor/async-await-in-loop
        const [, syncStateUpdate, , deleted] = await database.batch([
          database
            .insert(activityRetentionState)
            .select(sql`
              select ${actor.actorKey}, ${removedMaxSeq}, 1, null, null
              where ${gateStillOpen} and ${hasCleanupCandidates}
            `)
            .onConflictDoUpdate({
              target: activityRetentionState.actorKey,
              set: {
                compactedThroughSeq: sql`max(${activityRetentionState.compactedThroughSeq}, ${removedMaxSeq})`,
                retentionGeneration: sql`${activityRetentionState.retentionGeneration} + 1`,
              },
            }),
          database
            .update(activitySyncState)
            .set({
              retentionGeneration: sql`${activitySyncState.retentionGeneration} + 1`,
            })
            .where(and(eq(activitySyncState.id, 1), gateStillOpen, hasCleanupCandidates)),
          database.delete(activityChange).where(sql`
            ${activityChange.source} = 'github-atom-v1'
            and ${activityChange.activityId} in (${cleanupCandidates})
            and ${gateStillOpen}
          `),
          database.delete(feedItem).where(sql`
            ${feedItem.id} in (${cleanupCandidates})
            and ${gateStillOpen}
          `),
          database
            .update(activityRetentionState)
            .set({
              oldestRetainedPublishedAt: sql`(
                select ${feedItem.publishedAt}
                from ${feedItem}
                where ${feedItem.actorKey} = ${actor.actorKey}
                order by ${feedItem.publishedAt} asc, ${feedItem.id} asc
                limit 1
              )`,
              oldestRetainedActivityId: sql`(
                select ${feedItem.id}
                from ${feedItem}
                where ${feedItem.actorKey} = ${actor.actorKey}
                order by ${feedItem.publishedAt} asc, ${feedItem.id} asc
                limit 1
              )`,
            })
            .where(and(eq(activityRetentionState.actorKey, actor.actorKey), gateStillOpen)),
        ])
        totalDeleted += deleted.meta.changes
        if (syncStateUpdate.meta.changes === 0) {
          // A rollout epoch can rotate between actor batches; stop once its fence closes.
          // oxlint-disable-next-line react-doctor/async-await-in-loop
          const currentGate = await database
            .select({ id: localFeedServerState.id })
            .from(localFeedServerState)
            .where(
              and(
                eq(localFeedServerState.id, 1),
                eq(localFeedServerState.dataEpoch, gate.dataEpoch),
                isNotNull(localFeedServerState.activityReconciledAt),
                isNotNull(localFeedServerState.activityCleanupEnabledAt),
              ),
            )
            .limit(1)
          if (!currentGate[0]) break
        }
      }

      return { deleted: totalDeleted }
    },
  }
}
