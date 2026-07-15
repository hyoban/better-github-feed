export const REFRESH_COOLDOWN_MS = 5 * 60 * 1000
export const REFRESH_CLAIM_TIMEOUT_MS = 10 * 60 * 1000

export function shouldSkipRefresh(
  lastRefreshedAt: Date | null,
  refreshClaimedAt: Date | null,
  now: Date,
  cooldownMs = REFRESH_COOLDOWN_MS,
  claimTimeoutMs = REFRESH_CLAIM_TIMEOUT_MS,
) {
  const wasRefreshedRecently = lastRefreshedAt !== null
    && lastRefreshedAt.getTime() >= now.getTime() - cooldownMs
  const isRefreshInProgress = refreshClaimedAt !== null
    && refreshClaimedAt.getTime() >= now.getTime() - claimTimeoutMs

  return wasRefreshedRecently || isRefreshInProgress
}
