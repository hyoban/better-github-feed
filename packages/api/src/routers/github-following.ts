export type GithubFollowingUser = {
  id: string
  login: string
}

export type FollowingDiff = {
  toAdd: GithubFollowingUser[]
  toRemove: string[]
}

export type FollowingSnapshotRow = {
  githubId: string
  login: string
  subscriptionId: string
  createdAt: number
}

type Fetcher = typeof fetch

const GITHUB_FOLLOWING_URL = 'https://api.github.com/user/following?per_page=100'
const D1_JSON_CHUNK_MAX_BYTES = 1_800_000
const textEncoder = new TextEncoder()

export class GithubFollowingError extends Error {
  readonly status: number | undefined

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'GithubFollowingError'
    this.status = status
  }
}

function parseFollowingPage(value: unknown): GithubFollowingUser[] {
  if (!Array.isArray(value)) {
    throw new GithubFollowingError('GitHub returned an invalid following list')
  }

  return value.map((item) => {
    if (!item || typeof item !== 'object') {
      throw new GithubFollowingError('GitHub returned an invalid following list')
    }

    const { id, login } = item as Record<string, unknown>
    if (
      typeof id !== 'number'
      || !Number.isSafeInteger(id)
      || typeof login !== 'string'
      || !/^[a-z0-9-]{1,40}$/i.test(login)
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
    if (!match?.[1] || !match[2]?.split(/\s+/).includes('next')) {
      continue
    }

    let url: URL
    try {
      url = new URL(match[1])
    }
    catch {
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
          'Accept': 'application/vnd.github+json',
          'Authorization': `Bearer ${accessToken}`,
          'User-Agent': 'better-github-feed',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      })
    }
    catch (error) {
      if (error instanceof GithubFollowingError) {
        throw error
      }
      throw new GithubFollowingError('Unable to reach GitHub')
    }

    if (!response.ok) {
      throw new GithubFollowingError(
        `GitHub following request failed with status ${response.status}`,
        response.status,
      )
    }

    let value: unknown
    try {
      value = await response.json()
    }
    catch {
      throw new GithubFollowingError('GitHub returned an invalid following list')
    }

    for (const user of parseFollowingPage(value)) {
      following.set(user.login, user)
    }
    nextUrl = getNextPageUrl(response.headers.get('link'))
  }

  return [...following.values()]
}

export function buildFollowingDiff(
  currentLogins: string[],
  following: GithubFollowingUser[],
): FollowingDiff {
  const current = new Set(currentLogins)
  const remote = new Set(following.map(user => user.login))

  return {
    toAdd: following.filter(user => !current.has(user.login)),
    toRemove: currentLogins.filter(login => !remote.has(login)),
  }
}

export function serializeFollowingSnapshotChunks(
  rows: FollowingSnapshotRow[],
  maxBytes = D1_JSON_CHUNK_MAX_BYTES,
): string[] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 2) {
    throw new RangeError('Snapshot chunk size must fit a JSON array')
  }

  const chunks: string[] = []
  let currentRows: string[] = []
  let currentBytes = 2

  for (const row of rows) {
    const serializedRow = JSON.stringify(row)
    const rowBytes = textEncoder.encode(serializedRow).byteLength

    if (rowBytes + 2 > maxBytes) {
      throw new RangeError('Snapshot row exceeds the JSON chunk size')
    }

    const separatorBytes = currentRows.length > 0 ? 1 : 0
    if (currentBytes + separatorBytes + rowBytes > maxBytes) {
      chunks.push(`[${currentRows.join(',')}]`)
      currentRows = []
      currentBytes = 2
    }

    currentBytes += (currentRows.length > 0 ? 1 : 0) + rowBytes
    currentRows.push(serializedRow)
  }

  if (currentRows.length > 0) {
    chunks.push(`[${currentRows.join(',')}]`)
  }

  return chunks.length > 0 ? chunks : ['[]']
}
