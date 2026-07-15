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
        return new Response('rate limited', { status: 429 })
      }),
      (error: unknown) => {
        assert.ok(error instanceof GithubFollowingError)
        assert.equal(error.status, 429)
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
