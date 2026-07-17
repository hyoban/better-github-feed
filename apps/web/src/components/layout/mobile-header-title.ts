type UserIdentity = {
  actorKey: string
  login: string
}

export function mobileHeaderTitle(
  activeUsers: readonly string[],
  follows: readonly UserIdentity[],
) {
  if (activeUsers.length === 0) return 'GitHub Feed'

  const followByIdentity = new Map<string, UserIdentity>()
  for (const follow of follows) {
    followByIdentity.set(follow.actorKey, follow)
    followByIdentity.set(follow.login.trim().toLowerCase(), follow)
  }

  const selected: UserIdentity[] = []
  const selectedActorKeys = new Set<string>()
  for (const value of activeUsers) {
    const follow = followByIdentity.get(value) ?? followByIdentity.get(value.trim().toLowerCase())
    if (follow && !selectedActorKeys.has(follow.actorKey)) {
      selected.push(follow)
      selectedActorKeys.add(follow.actorKey)
    }
  }

  const first = selected[0]
  if (!first) return 'GitHub Feed'
  return selected.length === 1 ? first.login : `${first.login} +${selected.length - 1}`
}
