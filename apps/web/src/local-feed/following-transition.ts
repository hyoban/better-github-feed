export type FollowingIdentity = {
  actorKey: string
  legacyActorKeys: readonly string[]
}

export type FollowingTransitionPlan = {
  oldRevision: string
  newRevision: string
  targetThroughSeq: string
  addedActorCount: number
  oldMembershipSignature?: string | null
  newMembershipSignature?: string | null
}

export type FollowingTransitionCoverage = {
  bootstrap: 'initialized'
  remoteWindow: 'may-have-more' | 'exhausted'
  integrity: 'continuous'
}

export type FollowingSnapshotState = {
  activeRevision: string | null
  stagingRevision: string | null
  stagingCursor: string | null
  stagingComplete?: boolean
  stagingFinalizeCursorActorKey?: string | null
  stagingMembershipDigest?: string | null
  stagingMembershipCount?: number
  pendingTransition?: FollowingTransitionPlan | null
  membershipSignature?: string | null
}

function expandedKeys(members: readonly FollowingIdentity[]) {
  return [
    ...new Set(members.flatMap(member => [member.actorKey, ...member.legacyActorKeys])),
  ].sort()
}

export type FollowingMembershipDigest = {
  xor: string
  count: number
}

const EMPTY_MEMBERSHIP_DIGEST = '0'.repeat(64)

function xorDigests(left: string, right: string) {
  if (!/^[\da-f]{64}$/.test(left) || !/^[\da-f]{64}$/.test(right)) {
    throw new RangeError('Invalid Following membership digest')
  }
  let result = ''
  for (let index = 0; index < 64; index += 2) {
    result += (
      Number.parseInt(left.slice(index, index + 2), 16) ^
      Number.parseInt(right.slice(index, index + 2), 16)
    )
      .toString(16)
      .padStart(2, '0')
  }
  return result
}

export function mergeFollowingMembershipDigests(
  left: FollowingMembershipDigest,
  right: FollowingMembershipDigest,
): FollowingMembershipDigest {
  return {
    xor: xorDigests(left.xor, right.xor),
    count: left.count + right.count,
  }
}

export async function digestFollowingMembershipPage(
  members: readonly FollowingIdentity[],
): Promise<FollowingMembershipDigest> {
  const memberDigests = await Promise.all(
    members.map(async member => {
      const memberships = [...new Set([member.actorKey, ...member.legacyActorKeys])]
        .sort()
        .map(actorKey => `${actorKey}\u0000${member.actorKey}`)
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(JSON.stringify(memberships)),
      )
      return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
    }),
  )
  return memberDigests.reduce(
    (digest, memberDigest) => ({
      xor: xorDigests(digest.xor, memberDigest),
      count: digest.count + 1,
    }),
    { xor: EMPTY_MEMBERSHIP_DIGEST, count: 0 },
  )
}

export function followingMembershipSignatureFromDigest(digest: FollowingMembershipDigest) {
  if (!Number.isSafeInteger(digest.count) || digest.count < 0) {
    throw new RangeError('Invalid Following membership count')
  }
  return `${digest.count}:${digest.xor}`
}

export async function followingMembershipSignature(
  members: readonly FollowingIdentity[],
): Promise<string> {
  return followingMembershipSignatureFromDigest(await digestFollowingMembershipPage(members))
}

export function planFollowingTransition(input: {
  oldRevision: string | null
  newRevision: string
  targetThroughSeq: string
  oldMembers?: readonly FollowingIdentity[]
  newMembers?: readonly FollowingIdentity[]
  addedActorCount?: number
  oldMembershipSignature?: string | null
  newMembershipSignature?: string | null
}): FollowingTransitionPlan | null {
  if (!input.oldRevision || input.oldRevision === input.newRevision) return null
  const addedActorCount =
    input.addedActorCount ??
    (() => {
      const oldActorKeySet = new Set(expandedKeys(input.oldMembers ?? []))
      return expandedKeys(input.newMembers ?? []).filter(actorKey => !oldActorKeySet.has(actorKey))
        .length
    })()
  return {
    oldRevision: input.oldRevision,
    newRevision: input.newRevision,
    targetThroughSeq: input.targetThroughSeq,
    addedActorCount,
    oldMembershipSignature: input.oldMembershipSignature ?? null,
    newMembershipSignature: input.newMembershipSignature ?? null,
  }
}

export function deriveFollowingTransitionCoverage(input: {
  oldRemoteWindow: 'unchecked' | 'may-have-more' | 'exhausted' | null
  existingRemoteWindow: 'unchecked' | 'may-have-more' | 'exhausted' | null
  completedReplacementHistory: boolean
  completedAddedActorHistory: boolean
}): FollowingTransitionCoverage {
  const exhausted =
    input.existingRemoteWindow === 'exhausted' ||
    input.completedReplacementHistory ||
    (input.oldRemoteWindow === 'exhausted' && input.completedAddedActorHistory)
  return {
    bootstrap: 'initialized',
    remoteWindow: exhausted ? 'exhausted' : 'may-have-more',
    integrity: 'continuous',
  }
}

export function promoteFollowingSnapshot(input: {
  state: FollowingSnapshotState
  newRevision: string
  targetThroughSeq: string
  addedActorCount: number
  membershipSignature?: string | null
}): FollowingSnapshotState {
  return {
    ...input.state,
    activeRevision: input.newRevision,
    stagingRevision: null,
    stagingCursor: null,
    stagingComplete: false,
    stagingFinalizeCursorActorKey: null,
    stagingMembershipDigest: null,
    stagingMembershipCount: 0,
    membershipSignature: input.membershipSignature ?? null,
    pendingTransition: planFollowingTransition({
      oldRevision: input.state.activeRevision,
      newRevision: input.newRevision,
      targetThroughSeq: input.targetThroughSeq,
      addedActorCount: input.addedActorCount,
      oldMembershipSignature: input.state.membershipSignature ?? null,
      newMembershipSignature: input.membershipSignature ?? null,
    }),
  }
}

export function completeFollowingTransition(
  state: FollowingSnapshotState,
  completed: FollowingTransitionPlan,
): FollowingSnapshotState {
  return state.pendingTransition?.oldRevision === completed.oldRevision &&
    state.pendingTransition.newRevision === completed.newRevision
    ? { ...state, pendingTransition: null }
    : state
}
