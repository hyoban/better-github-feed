import assert from 'node:assert/strict'

import { describe, it } from 'vite-plus/test'

import {
  expectedSignOutMatches,
  expectedSessionTokenMatches,
  EXPECTED_SIGN_OUT_OWNER_HEADER,
  EXPECTED_SIGN_OUT_SESSION_HEADER,
  readExpectedSignOutProof,
} from './expected-sign-out'

describe('expected remote sign out', () => {
  it('binds sign out to both the numeric GitHub owner and server session', () => {
    const proof = readExpectedSignOutProof(
      new Headers({
        [EXPECTED_SIGN_OUT_OWNER_HEADER]: '38493346',
        [EXPECTED_SIGN_OUT_SESSION_HEADER]: 'session-a',
      }),
    )
    assert.ok(proof)
    assert.equal(
      expectedSignOutMatches(proof, { id: 'session-a' }, [
        { providerId: 'github', accountId: '38493346' },
      ]),
      true,
    )
    assert.equal(
      expectedSignOutMatches(proof, { id: 'session-b' }, [
        { providerId: 'github', accountId: '38493346' },
      ]),
      false,
    )
    assert.equal(
      expectedSignOutMatches(proof, { id: 'session-a' }, [
        { providerId: 'github', accountId: '2' },
      ]),
      false,
    )
    assert.equal(
      expectedSignOutMatches(proof, { id: 'session-a' }, [
        { providerId: 'github', accountId: '38493346' },
        { providerId: 'github', accountId: '2' },
      ]),
      false,
    )
  })

  it('allows an already-expired expected session without touching a newer session', () => {
    assert.equal(
      expectedSignOutMatches({ ownerGithubId: '38493346', sessionId: 'expired' }, null, []),
      true,
    )
  })

  it('revokes only the exact expected session token', () => {
    assert.equal(expectedSessionTokenMatches('token-a', 'token-a'), true)
    assert.equal(expectedSessionTokenMatches('token-a', 'token-b'), false)
    assert.equal(expectedSessionTokenMatches(undefined, 'token-a'), false)
  })

  it('rejects missing or non-numeric expected owner headers', () => {
    assert.equal(readExpectedSignOutProof(new Headers()), null)
    assert.equal(
      readExpectedSignOutProof(
        new Headers({
          [EXPECTED_SIGN_OUT_OWNER_HEADER]: 'github:38493346',
          [EXPECTED_SIGN_OUT_SESSION_HEADER]: 'session-a',
        }),
      ),
      null,
    )
  })
})
