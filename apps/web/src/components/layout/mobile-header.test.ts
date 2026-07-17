import assert from 'node:assert/strict'

import { describe, it } from 'vite-plus/test'

import { mobileHeaderTitle } from './mobile-header-title'

const follows = [
  { actorKey: 'github:1', login: 'alice' },
  { actorKey: 'github:2', login: 'Bob' },
]

describe('mobileHeaderTitle', () => {
  it('keeps the product title without a user selection', () => {
    assert.equal(mobileHeaderTitle([], follows), 'GitHub Feed')
  })

  it('shows the selected user for actor keys and legacy login values', () => {
    assert.equal(mobileHeaderTitle(['github:1'], follows), 'alice')
    assert.equal(mobileHeaderTitle(['bob'], follows), 'Bob')
  })

  it('summarizes multiple selected users', () => {
    assert.equal(mobileHeaderTitle(['github:1', 'github:2'], follows), 'alice +1')
    assert.equal(mobileHeaderTitle(['github:1', 'alice'], follows), 'alice')
  })

  it('keeps the product title until the local Following projection resolves', () => {
    assert.equal(mobileHeaderTitle(['github:1'], []), 'GitHub Feed')
  })
})
