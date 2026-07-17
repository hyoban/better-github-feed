type InitialFollowingDependencies<Result> = {
  syncFollowing: (userId: string) => Promise<Result>
  refreshUninitializedFollowing: (userId: string) => Promise<unknown>
}

export async function initializeGithubFollowing<Result>(
  userId: string,
  dependencies: InitialFollowingDependencies<Result>,
) {
  const result = await dependencies.syncFollowing(userId)
  await dependencies.refreshUninitializedFollowing(userId)
  return result
}
