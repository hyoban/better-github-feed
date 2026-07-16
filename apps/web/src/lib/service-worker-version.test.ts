import assert from 'node:assert/strict'

import { describe, it } from 'vite-plus/test'

import { shellMarkupVersion } from './service-worker-version'

describe('service worker deployment version', () => {
  it('changes whenever the generated shell HTML or asset manifest changes', async () => {
    const initial = await shellMarkupVersion(
      '<html><script src="/assets/index-a.js"></script><link href="/assets/index-a.css"></html>',
    )
    const changedScript = await shellMarkupVersion(
      '<html><script src="/assets/index-b.js"></script><link href="/assets/index-a.css"></html>',
    )
    const changedMarkup = await shellMarkupVersion(
      '<html><script src="/assets/index-a.js"></script><link href="/assets/index-a.css"><title>New</title></html>',
    )

    assert.equal(initial.length, 64)
    assert.notEqual(initial, changedScript)
    assert.notEqual(initial, changedMarkup)
    assert.equal(
      initial,
      await shellMarkupVersion(
        '<html><script src="/assets/index-a.js"></script><link href="/assets/index-a.css"></html>',
      ),
    )
  })
})
