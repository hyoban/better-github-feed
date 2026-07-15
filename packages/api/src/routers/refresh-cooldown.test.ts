/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  REFRESH_CLAIM_TIMEOUT_MS,
  REFRESH_COOLDOWN_MS,
  shouldSkipRefresh,
} from './refresh-cooldown.ts'

describe('shouldSkipRefresh', () => {
  const now = new Date('2026-07-15T12:00:00.000Z')

  it('skips users refreshed within the cooldown window', () => {
    const lastRefreshedAt = new Date(now.getTime() - REFRESH_COOLDOWN_MS + 1)

    assert.equal(shouldSkipRefresh(lastRefreshedAt, null, now), true)
  })

  it('skips users refreshed exactly at the cooldown boundary', () => {
    const lastRefreshedAt = new Date(now.getTime() - REFRESH_COOLDOWN_MS)

    assert.equal(shouldSkipRefresh(lastRefreshedAt, null, now), true)
  })

  it('allows users whose cooldown has expired', () => {
    const lastRefreshedAt = new Date(now.getTime() - REFRESH_COOLDOWN_MS - 1)

    assert.equal(shouldSkipRefresh(lastRefreshedAt, null, now), false)
  })

  it('allows users that have never been refreshed', () => {
    assert.equal(shouldSkipRefresh(null, null, now), false)
  })

  it('skips users with an active refresh claim', () => {
    const refreshClaimedAt = new Date(now.getTime() - REFRESH_CLAIM_TIMEOUT_MS + 1)

    assert.equal(shouldSkipRefresh(null, refreshClaimedAt, now), true)
  })

  it('allows users whose abandoned refresh claim has expired', () => {
    const refreshClaimedAt = new Date(now.getTime() - REFRESH_CLAIM_TIMEOUT_MS - 1)

    assert.equal(shouldSkipRefresh(null, refreshClaimedAt, now), false)
  })
})
