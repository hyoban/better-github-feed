import type { FollowingSummary } from '@/local-feed'

type ActorAlias = Pick<FollowingSummary, 'actorKey' | 'login'>

export function canonicalizeActorSelection(
  values: readonly string[],
  follows: readonly ActorAlias[],
  followingWindowIsComplete: boolean,
) {
  const actorKeys = new Set(follows.map(follow => follow.actorKey))
  const actorKeyByLogin = new Map(
    follows.map(follow => [follow.login.trim().toLowerCase(), follow.actorKey]),
  )
  const selection: string[] = []
  const selected = new Set<string>()

  for (const value of values) {
    const canonical = actorKeys.has(value) ? value : actorKeyByLogin.get(value.trim().toLowerCase())
    if (canonical && !selected.has(canonical)) {
      selection.push(canonical)
      selected.add(canonical)
    } else if (!canonical && !followingWindowIsComplete && !selected.has(value)) {
      selection.push(value)
      selected.add(value)
    }
  }

  return selection
}
