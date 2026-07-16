import assert from 'node:assert/strict'

import { describe, it } from 'vite-plus/test'

import { shouldExtendLocalActivityWindow } from './automatic-window'

describe('automatic local Activity window', () => {
  it('extends only when the local window sentinel becomes visible', () => {
    assert.equal(
      shouldExtendLocalActivityWindow({
        alreadyExtendedAtFrontier: false,
        hasMoreLocal: true,
        itemCount: 40,
        lastVirtualIndex: 39,
      }),
      false,
    )
    assert.equal(
      shouldExtendLocalActivityWindow({
        alreadyExtendedAtFrontier: false,
        hasMoreLocal: true,
        itemCount: 40,
        lastVirtualIndex: 40,
      }),
      true,
    )
  })

  it('ignores a stale or already-extended frontier', () => {
    assert.equal(
      shouldExtendLocalActivityWindow({
        alreadyExtendedAtFrontier: false,
        hasMoreLocal: true,
        itemCount: 60,
        lastVirtualIndex: 40,
      }),
      false,
    )
    assert.equal(
      shouldExtendLocalActivityWindow({
        alreadyExtendedAtFrontier: true,
        hasMoreLocal: true,
        itemCount: 40,
        lastVirtualIndex: 40,
      }),
      false,
    )
  })

  it('stops when all locally synced Activity is visible', () => {
    assert.equal(
      shouldExtendLocalActivityWindow({
        alreadyExtendedAtFrontier: false,
        hasMoreLocal: false,
        itemCount: 40,
        lastVirtualIndex: 40,
      }),
      false,
    )
  })
})
