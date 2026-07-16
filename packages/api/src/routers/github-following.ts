import type { GithubFollowingUser } from '../following/following-sync'

type Fetcher = typeof fetch

const GITHUB_FOLLOWING_URL = 'https://api.github.com/user/following?per_page=100'
const GITHUB_FOLLOWING_TIMEOUT_MS = 60 * 1000

export class GithubFollowingError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryAt?: number,
  ) {
    super(message)
    this.name = 'GithubFollowingError'
  }
}

function parseRateLimitRetryAt(headers: Headers, now = Date.now()) {
  const retryAfter = headers.get('retry-after')
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) return now + seconds * 1000
    const date = Date.parse(retryAfter)
    if (Number.isFinite(date) && date > now) return date
  }
  const resetSeconds = Number(headers.get('x-ratelimit-reset'))
  return Number.isFinite(resetSeconds) && resetSeconds > 0 ? resetSeconds * 1000 : undefined
}

function getRateLimitRetryAt(status: number, headers: Headers, body: string, now = Date.now()) {
  const retryAt = parseRateLimitRetryAt(headers, now)
  if (status === 429) {
    return retryAt
  }
  if (status !== 403) {
    return undefined
  }

  const isRateLimited =
    headers.get('x-ratelimit-remaining')?.trim() === '0' ||
    headers.has('retry-after') ||
    /secondary rate limit/i.test(body)
  return isRateLimited ? (retryAt ?? now + 60_000) : undefined
}

function parseFollowingPage(value: unknown): GithubFollowingUser[] {
  if (!Array.isArray(value)) {
    throw new GithubFollowingError('GitHub returned an invalid following list')
  }

  return value.map(item => {
    if (!item || typeof item !== 'object') {
      throw new GithubFollowingError('GitHub returned an invalid following list')
    }

    const { id, login } = item as Record<string, unknown>
    if (
      typeof id !== 'number' ||
      !Number.isSafeInteger(id) ||
      typeof login !== 'string' ||
      !/^[a-z0-9-]{1,40}$/i.test(login)
    ) {
      throw new GithubFollowingError('GitHub returned an invalid following list')
    }

    return {
      id: String(id),
      login: login.toLowerCase(),
    }
  })
}

function getNextPageUrl(linkHeader: string | null) {
  if (!linkHeader) {
    return null
  }

  for (const link of linkHeader.split(',')) {
    const match = link.trim().match(/^<([^>]+)>;\s*rel="([^"]+)"$/)
    if (!match?.[1] || !match[2] || !/(?:^|\s)next(?:\s|$)/.test(match[2])) {
      continue
    }

    let url: URL
    try {
      url = new URL(match[1])
    } catch {
      throw new GithubFollowingError('GitHub returned an invalid pagination link')
    }

    if (url.origin !== 'https://api.github.com' || url.pathname !== '/user/following') {
      throw new GithubFollowingError('GitHub returned an invalid pagination link')
    }

    return url.toString()
  }

  return null
}

export async function fetchGithubFollowing(
  accessToken: string,
  fetcher: Fetcher = fetch,
): Promise<GithubFollowingUser[]> {
  const following = new Map<string, GithubFollowingUser>()
  const visitedUrls = new Set<string>()
  const signal = AbortSignal.timeout(GITHUB_FOLLOWING_TIMEOUT_MS)
  let nextUrl: string | null = GITHUB_FOLLOWING_URL

  while (nextUrl) {
    if (visitedUrls.has(nextUrl)) {
      throw new GithubFollowingError('GitHub returned a pagination loop')
    }
    visitedUrls.add(nextUrl)

    let response: Response
    try {
      response = await fetcher(nextUrl, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${accessToken}`,
          'User-Agent': 'better-github-feed',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal,
      })
    } catch (error) {
      if (error instanceof GithubFollowingError) {
        throw error
      }
      throw new GithubFollowingError('Unable to reach GitHub')
    }

    if (!response.ok) {
      const errorBody = response.status === 403 ? await response.text() : ''
      throw new GithubFollowingError(
        `GitHub following request failed with status ${response.status}`,
        response.status,
        getRateLimitRetryAt(response.status, response.headers, errorBody),
      )
    }

    let value: unknown
    try {
      value = await response.json()
    } catch {
      throw new GithubFollowingError('GitHub returned an invalid following list')
    }

    for (const user of parseFollowingPage(value)) {
      following.set(user.login, user)
    }
    nextUrl = getNextPageUrl(response.headers.get('link'))
  }

  return [...following.values()]
}
