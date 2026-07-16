import type { Database } from '@better-github-feed/db'
import {
  userMutationReceipt,
  userStateChange,
  userStateSyncState,
} from '@better-github-feed/db/schema/github'
import { sql } from 'drizzle-orm'

export const DEFAULT_USER_STATE_CHANGE_RETENTION = 2_000
export const DEFAULT_USER_MUTATION_RECEIPT_RETENTION = 2_000

function assertRetentionLimit(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer`)
  }
}

/**
 * Bounds the replay log and retry receipts without changing the canonical user
 * entities. Advancing each user's floor and deleting its covered changes happen
 * in one D1 batch, so a pull either sees the old delta or is forced to snapshot.
 */
export function createUserStateCompaction(database: Database) {
  return {
    async compact(
      maxChangesPerUser = DEFAULT_USER_STATE_CHANGE_RETENTION,
      maxReceiptsPerUser = DEFAULT_USER_MUTATION_RECEIPT_RETENTION,
    ) {
      assertRetentionLimit(maxChangesPerUser, 'User-state change retention')
      assertRetentionLimit(maxReceiptsPerUser, 'Mutation receipt retention')

      const [floors, changes, receipts] = await database.batch([
        database.update(userStateSyncState).set({
          compactedThroughSeq: sql`max(
              ${userStateSyncState.compactedThroughSeq},
              coalesce((
                select max(compacted.seq)
                from (
                  select ${userStateChange.seq} as seq
                  from ${userStateChange}
                  where ${userStateChange.userId} = ${userStateSyncState.userId}
                  order by ${userStateChange.seq} desc
                  limit -1 offset ${maxChangesPerUser}
                ) as compacted
              ), ${userStateSyncState.compactedThroughSeq})
            )`,
        }).where(sql`exists (
            select 1
            from ${userStateChange}
            where ${userStateChange.userId} = ${userStateSyncState.userId}
            order by ${userStateChange.seq} desc
            limit 1 offset ${maxChangesPerUser}
          )`),
        database.delete(userStateChange).where(sql`
          ${userStateChange.seq} <= coalesce((
            select ${userStateSyncState.compactedThroughSeq}
            from ${userStateSyncState}
            where ${userStateSyncState.userId} = ${userStateChange.userId}
          ), 0)
        `),
        database.delete(userMutationReceipt).where(sql`(
          ${userMutationReceipt.userId}, ${userMutationReceipt.attemptId}
        ) in (
          select ranked.user_id, ranked.attempt_id
          from (
            select
              ${userMutationReceipt.userId} as user_id,
              ${userMutationReceipt.attemptId} as attempt_id,
              row_number() over (
                partition by ${userMutationReceipt.userId}
                order by ${userMutationReceipt.createdAt} desc,
                  ${userMutationReceipt.attemptId} desc
              ) as receipt_rank
            from ${userMutationReceipt}
          ) as ranked
          where ranked.receipt_rank > ${maxReceiptsPerUser}
        )`),
      ])

      return {
        advancedFloors: floors.meta.changes,
        deletedChanges: changes.meta.changes,
        deletedReceipts: receipts.meta.changes,
      }
    },
  }
}
