import assert from 'node:assert/strict'

import { describe, it } from 'vite-plus/test'

import { selectStableProjectionSnapshot } from './stable-projection-state'

describe('stable local projection state', () => {
  it('keeps the previous local result while a new projection opens', () => {
    const previous = {
      kind: 'ready' as const,
      localRevision: 7,
      value: { items: [{ id: 'previous' }] },
    }

    assert.equal(selectStableProjectionSnapshot({ kind: 'opening-local' }, previous), previous)
  })

  it('replaces the previous result as soon as the new local result is ready', () => {
    const previous = {
      kind: 'ready' as const,
      localRevision: 7,
      value: { items: [{ id: 'previous' }] },
    }
    const current = {
      kind: 'ready' as const,
      localRevision: 8,
      value: { items: [{ id: 'current' }] },
    }

    assert.equal(selectStableProjectionSnapshot(current, previous), current)
  })
})
