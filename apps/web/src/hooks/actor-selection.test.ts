import assert from 'node:assert/strict'

import { describe, it } from 'vite-plus/test'

import { canonicalizeActorSelection } from './actor-selection'

const follows = [
  { actorKey: 'github:1', login: 'Alice' },
  { actorKey: 'github:2', login: 'bob' },
]

describe('canonicalizeActorSelection', () => {
  it('migrates legacy login parameters to stable actor keys', () => {
    assert.deepEqual(canonicalizeActorSelection(['alice', 'ALICE', 'github:2'], follows, true), [
      'github:1',
      'github:2',
    ])
  })

  it('keeps unresolved parameters until Following coverage is complete', () => {
    assert.deepEqual(canonicalizeActorSelection(['old-login'], follows, false), ['old-login'])
    assert.deepEqual(canonicalizeActorSelection(['old-login'], follows, true), [])
  })
})
