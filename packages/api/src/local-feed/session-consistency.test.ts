import assert from 'node:assert/strict'

import { describe, it } from 'vite-plus/test'

import { manifestSessionConstraint } from './session-consistency.ts'

describe('D1 session consistency', () => {
  it('starts manifest checks from the latest primary state across devices', () => {
    assert.equal(manifestSessionConstraint('stale-device-bookmark'), 'first-primary')
  })
})
