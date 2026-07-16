import type { FollowingMemberRow } from './database'

type MemberIdentity = Pick<FollowingMemberRow, 'actorKey' | 'legacyActorKeys'>

export function expandAuthorizedActorSelection(
  members: readonly MemberIdentity[],
  requestedActorKeys: readonly string[],
) {
  const memberByKey = new Map<string, MemberIdentity>()
  for (const member of members) {
    memberByKey.set(member.actorKey, member)
    for (const actorKey of member.legacyActorKeys) memberByKey.set(actorKey, member)
  }

  const actorKeys = new Set<string>()
  const rejectedActorKeys: string[] = []
  for (const requested of requestedActorKeys) {
    const member = memberByKey.get(requested)
    if (!member) {
      rejectedActorKeys.push(requested)
      continue
    }
    actorKeys.add(member.actorKey)
    for (const actorKey of member.legacyActorKeys) actorKeys.add(actorKey)
  }
  return { actorKeys: [...actorKeys].sort(), rejectedActorKeys }
}
