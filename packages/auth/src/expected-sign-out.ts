export const EXPECTED_SIGN_OUT_OWNER_HEADER = 'x-better-github-feed-owner'
export const EXPECTED_SIGN_OUT_SESSION_HEADER = 'x-better-github-feed-session'

export type ExpectedSignOutProof = {
  ownerGithubId: string
  sessionId: string
}

export function readExpectedSignOutProof(
  headers: Pick<Headers, 'get'>,
): ExpectedSignOutProof | null {
  const ownerGithubId = headers.get(EXPECTED_SIGN_OUT_OWNER_HEADER)
  const sessionId = headers.get(EXPECTED_SIGN_OUT_SESSION_HEADER)
  if (!ownerGithubId || !/^[1-9]\d*$/.test(ownerGithubId)) return null
  if (!sessionId || sessionId.length > 200) return null
  return { ownerGithubId, sessionId }
}

export function expectedSignOutMatches(
  proof: ExpectedSignOutProof,
  session: { id: string } | null,
  accounts: readonly { providerId: string; accountId: string }[],
): boolean {
  if (!session) return true
  if (session.id !== proof.sessionId) return false
  const githubAccounts = accounts.filter(account => account.providerId === 'github')
  return githubAccounts.length === 1 && githubAccounts[0]?.accountId === proof.ownerGithubId
}

export function expectedSessionTokenMatches(expectedToken: unknown, currentToken: string): boolean {
  return typeof expectedToken === 'string' && expectedToken === currentToken
}
