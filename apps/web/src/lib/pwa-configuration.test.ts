import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { describe, it } from 'vite-plus/test'

const publicFile = (name: string) => new URL(`../../public/${name}`, import.meta.url)

describe('PWA configuration', () => {
  it('declares a stable install identity and distinct maskable assets', async () => {
    const manifest = JSON.parse(await readFile(publicFile('manifest.webmanifest'), 'utf8'))

    assert.equal(manifest.id, '/')
    assert.equal(manifest.start_url, '/')
    assert.equal(manifest.scope, '/')
    assert.equal(manifest.display, 'standalone')
    assert.equal(manifest.lang, 'en')
    assert.deepEqual(
      manifest.screenshots.map(
        (screenshot: { src: string; sizes: string; form_factor?: string }) => [
          screenshot.src,
          screenshot.sizes,
          screenshot.form_factor ?? null,
        ],
      ),
      [
        ['/screenshots/desktop-feed.jpg', '2860x2270', 'wide'],
        ['/screenshots/mobile-feed.jpg', '1179x2556', null],
      ],
    )
    assert.deepEqual(
      manifest.icons.map((icon: { src: string; purpose: string }) => [icon.src, icon.purpose]),
      [
        ['/icon-192.png', 'any'],
        ['/icon-512.png', 'any'],
        ['/icon-maskable-192.png', 'maskable'],
        ['/icon-maskable-512.png', 'maskable'],
      ],
    )
  })

  it('ships stable worker and immutable fingerprinted-asset headers', async () => {
    const headers = await readFile(publicFile('_headers'), 'utf8')

    assert.match(headers, /\/sw\.js\n {2}Cache-Control: no-cache/)
    assert.match(headers, /\/assets\/\*\n {2}Cache-Control: public, max-age=31536000, immutable/)
  })

  it('keeps the worker build-owned and the API network-only', async () => {
    const [worker, registration] = await Promise.all([
      readFile(new URL('../service-worker/sw.js', import.meta.url), 'utf8'),
      readFile(new URL('./register-service-worker.ts', import.meta.url), 'utf8'),
    ])

    assert.match(worker, /globalThis\.__WB_MANIFEST/)
    assert.match(worker, /pathname\.startsWith\('\/api\/'\)/)
    assert.doesNotMatch(worker, /better-github-feed-shell-v3/)
    assert.match(registration, /const SERVICE_WORKER_URL = '\/sw\.js'/)
    assert.match(registration, /updateViaCache: 'none'/)
    assert.doesNotMatch(registration, /worker&url/)
  })
})
