import type { FeedView } from './types'
import type { LocalFeedDatabase } from './database'

export async function readFollowedActorKeys(
  database: LocalFeedDatabase,
  snapshotRevision: string,
  actorKeys: readonly string[],
) {
  const unique = [...new Set(actorKeys)]
  const rows = await database.followingMemberships.bulkGet(
    unique.map(actorKey => [snapshotRevision, actorKey]),
  )
  return new Set(rows.flatMap((row, index) => (row ? [unique[index]!] : [])))
}

export async function readAuthorizedActorSelection(
  database: LocalFeedDatabase,
  snapshotRevision: string,
  requested: Exclude<FeedView['actors'], 'following'>,
) {
  const uniqueRequested = [...new Set(requested)]
  const memberships = await database.followingMemberships.bulkGet(
    uniqueRequested.map(actorKey => [snapshotRevision, actorKey]),
  )
  const memberActorKeys = [
    ...new Set(memberships.flatMap(row => (row ? [row.memberActorKey] : []))),
  ]
  const members = await database.followingMembers.bulkGet(
    memberActorKeys.map(actorKey => [snapshotRevision, actorKey]),
  )
  return {
    actorKeys: [
      ...new Set(
        members.flatMap(member => (member ? [member.actorKey, ...member.legacyActorKeys] : [])),
      ),
    ],
    rejectedActorKeys: uniqueRequested.filter((_, index) => !memberships[index]),
  }
}
