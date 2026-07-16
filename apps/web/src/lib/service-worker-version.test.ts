import assert from 'node:assert/strict'

import { describe, it } from 'vite-plus/test'

import { shellMarkupVersion } from './service-worker-version'

describe('service worker deployment version', () => {
  it('changes whenever the generated asset manifest changes', async () => {
    const initial = await shellMarkupVersion(
      '<html><script src="/assets/index-a.js"></script><link href="/assets/index-a.css"></html>',
    )
    const changedScript = await shellMarkupVersion(
      '<html><script src="/assets/index-b.js"></script><link href="/assets/index-a.css"></html>',
    )
    const changedStyles = await shellMarkupVersion(
      '<html><script src="/assets/index-a.js"></script><link href="/assets/index-b.css"></html>',
    )
    const extensionInjected = await shellMarkupVersion(
      '<html data-extension-state="random"><head><script src="/assets/index-a.js"></script><link href="/assets/index-a.css"><script src="chrome-extension://example/content.js"></script></head><body><div class="extension-overlay"></div></body></html>',
    )
    const reorderedWithQueries = await shellMarkupVersion(
      '<html><link href="/assets/index-a.css?v=random"><script src="/assets/index-a.js#fragment"></script></html>',
    )

    assert.equal(initial.length, 64)
    assert.notEqual(initial, changedScript)
    assert.notEqual(initial, changedStyles)
    assert.equal(initial, extensionInjected)
    assert.equal(initial, reorderedWithQueries)
    assert.equal(
      initial,
      await shellMarkupVersion(
        '<html><script src="/assets/index-a.js"></script><link href="/assets/index-a.css"></html>',
      ),
    )
  })
})
