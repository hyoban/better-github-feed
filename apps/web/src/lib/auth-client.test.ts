import assert from 'node:assert/strict'

import { describe, it } from 'vite-plus/test'

import { authClientOptions } from './auth-client'

describe('auth client', () => {
  it('leaves window-focus session verification to the local account controller', () => {
    assert.equal(authClientOptions.sessionOptions.refetchOnWindowFocus, false)
  })
})
