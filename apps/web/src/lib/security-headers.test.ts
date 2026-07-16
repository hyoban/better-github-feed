import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { describe, it } from 'vite-plus/test'

describe('security headers', () => {
  it('allows the service worker to fetch HTTPS images for offline caching', async () => {
    const headers = await readFile(new URL('../../public/_headers', import.meta.url), 'utf8')
    const contentSecurityPolicy = headers
      .split('\n')
      .find(line => line.trimStart().startsWith('Content-Security-Policy:'))

    assert.ok(contentSecurityPolicy)
    assert.match(contentSecurityPolicy, /(?:^|;) connect-src 'self' https:(?:;|$)/)
  })
})
