import assert from 'node:assert/strict'

import { describe, it } from 'vite-plus/test'

import { shouldExtendActivityDemand } from './automatic-demand'

describe('automatic Activity demand', () => {
  it('continues an empty view while retained history may still satisfy it', () => {
    assert.equal(
      shouldExtendActivityDemand({
        hasMoreHistory: true,
        itemCount: 0,
        lastVirtualIndex: undefined,
      }),
      true,
    )
  })

  it('extends only when the virtual history sentinel becomes visible', () => {
    assert.equal(
      shouldExtendActivityDemand({
        hasMoreHistory: true,
        itemCount: 40,
        lastVirtualIndex: 39,
      }),
      false,
    )
    assert.equal(
      shouldExtendActivityDemand({
        hasMoreHistory: true,
        itemCount: 40,
        lastVirtualIndex: 40,
      }),
      true,
    )
  })

  it('ignores a stale frontier after a larger snapshot becomes ready', () => {
    assert.equal(
      shouldExtendActivityDemand({
        hasMoreHistory: true,
        itemCount: 60,
        lastVirtualIndex: 40,
      }),
      false,
    )
  })

  it('stops extending after local and retained history are exhausted', () => {
    assert.equal(
      shouldExtendActivityDemand({
        hasMoreHistory: false,
        itemCount: 40,
        lastVirtualIndex: 40,
      }),
      false,
    )
  })
})
