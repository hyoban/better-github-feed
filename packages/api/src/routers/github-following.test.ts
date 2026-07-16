import assert from 'node:assert/strict'
import { describe, it } from 'vite-plus/test'

import { fetchGithubFollowing, GithubFollowingError } from './github-following.ts'

describe('fetchGithubFollowing', () => {
  it('loads every page and normalizes duplicate logins', async () => {
    const requests: Request[] = []
    const pages = [
      new Response(
        JSON.stringify([
          { id: 1, login: 'Alice' },
          { id: 2, login: 'bob' },
        ]),
        {
          headers: {
            link: '<https://api.github.com/user/following?per_page=100&page=2>; rel="prev next"',
          },
        },
      ),
      new Response(
        JSON.stringify([
          { id: 1, login: 'alice' },
          { id: 3, login: 'Carol' },
        ]),
      ),
    ]

    const following = await fetchGithubFollowing('secret-token', async (input, init) => {
      requests.push(new Request(input, init))
      const response = pages.shift()
      assert.ok(response)
      return response
    })

    assert.deepEqual(following, [
      { id: '1', login: 'alice' },
      { id: '2', login: 'bob' },
      { id: '3', login: 'carol' },
    ])
    assert.equal(requests.length, 2)
    assert.equal(requests[0]?.headers.get('authorization'), 'Bearer secret-token')
    assert.equal(requests[1]?.url, 'https://api.github.com/user/following?per_page=100&page=2')
  })

  it('rejects an incomplete result when a later page fails', async () => {
    let requestCount = 0

    await assert.rejects(
      fetchGithubFollowing('secret-token', async () => {
        requestCount += 1
        if (requestCount === 1) {
          return new Response(JSON.stringify([{ id: 1, login: 'alice' }]), {
            headers: {
              link: '<https://api.github.com/user/following?page=2>; rel="next"',
            },
          })
        }
        return new Response('rate limited', {
          status: 429,
          headers: { 'x-ratelimit-reset': '9000000000' },
        })
      }),
      (error: unknown) => {
        assert.ok(error instanceof GithubFollowingError)
        assert.equal(error.status, 429)
        assert.equal(error.retryAt, 9_000_000_000_000)
        return true
      },
    )
  })

  it('does not treat an ordinary forbidden response as a rate limit', async () => {
    await assert.rejects(
      fetchGithubFollowing('secret-token', async () => {
        return new Response(JSON.stringify({ message: 'Resource not accessible by integration' }), {
          status: 403,
          headers: {
            'x-ratelimit-remaining': '42',
            'x-ratelimit-reset': '9000000000',
          },
        })
      }),
      (error: unknown) => {
        assert.ok(error instanceof GithubFollowingError)
        assert.equal(error.status, 403)
        assert.equal(error.retryAt, undefined)
        return true
      },
    )
  })

  it('uses the primary rate-limit reset only when GitHub reports no remaining requests', async () => {
    await assert.rejects(
      fetchGithubFollowing('secret-token', async () => {
        return new Response(JSON.stringify({ message: 'API rate limit exceeded' }), {
          status: 403,
          headers: {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': '9000000000',
          },
        })
      }),
      (error: unknown) => {
        assert.ok(error instanceof GithubFollowingError)
        assert.equal(error.status, 403)
        assert.equal(error.retryAt, 9_000_000_000_000)
        return true
      },
    )
  })

  it('honors Retry-After on a forbidden response', async () => {
    const retryAt = Date.parse('2037-10-21T07:28:00.000Z')
    await assert.rejects(
      fetchGithubFollowing('secret-token', async () => {
        return new Response(JSON.stringify({ message: 'Please retry later' }), {
          status: 403,
          headers: {
            'retry-after': new Date(retryAt).toUTCString(),
            'x-ratelimit-remaining': '42',
          },
        })
      }),
      (error: unknown) => {
        assert.ok(error instanceof GithubFollowingError)
        assert.equal(error.status, 403)
        assert.equal(error.retryAt, retryAt)
        return true
      },
    )
  })

  it('backs off an explicit secondary rate limit even without rate-limit headers', async () => {
    const requestedAt = Date.now()
    await assert.rejects(
      fetchGithubFollowing('secret-token', async () => {
        return new Response(
          JSON.stringify({ message: 'You have exceeded a secondary rate limit.' }),
          { status: 403 },
        )
      }),
      (error: unknown) => {
        assert.ok(error instanceof GithubFollowingError)
        assert.equal(error.status, 403)
        assert.ok(error.retryAt)
        assert.ok(error.retryAt >= requestedAt + 60_000)
        assert.ok(error.retryAt <= Date.now() + 60_000)
        return true
      },
    )
  })

  it('rejects pagination links that leave the GitHub following endpoint', async () => {
    await assert.rejects(
      fetchGithubFollowing('secret-token', async () => {
        return new Response(JSON.stringify([{ id: 1, login: 'alice' }]), {
          headers: {
            link: '<https://example.com/steal-token>; rel="next"',
          },
        })
      }),
      GithubFollowingError,
    )
  })

  it('rejects malformed GitHub user records', async () => {
    await assert.rejects(
      fetchGithubFollowing('secret-token', async () => {
        return new Response(JSON.stringify([{ id: 'not-a-number', login: '' }]))
      }),
      GithubFollowingError,
    )
  })
})
