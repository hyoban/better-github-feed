import assert from 'node:assert/strict'

import { describe, it } from 'vite-plus/test'

import { sortSelectionTransition, userSelectionTransition } from './feed-selection-transition'

describe('feed selection transitions', () => {
  it('clears user and item selections when the sort changes', () => {
    assert.deepEqual(sortSelectionTransition('latest', 'name'), {
      sort: 'name',
      users: [],
      id: null,
    })
    assert.equal(sortSelectionTransition('latest', 'latest'), null)
  })

  it('clears the item selection when the user selection changes', () => {
    assert.deepEqual(userSelectionTransition(['github:1'], ['github:2']), {
      users: ['github:2'],
      id: null,
    })
    assert.deepEqual(userSelectionTransition(['github:1'], ['github:1', 'github:2']), {
      users: ['github:1', 'github:2'],
      id: null,
    })
    assert.equal(userSelectionTransition(['github:1'], ['github:1']), null)
  })
})
