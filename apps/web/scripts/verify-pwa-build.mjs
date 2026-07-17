import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'

const output = new URL('../dist/client/', import.meta.url)
const files = await readdir(output)

assert.ok(files.includes('sw.js'), 'The production build must emit stable /sw.js')
assert.equal(
  files.some(file => /^sw-[\w-]+\.js$/.test(file)),
  false,
  'The service worker filename must not be content-addressed',
)

const [worker, manifestSource, headers, index] = await Promise.all([
  readFile(new URL('sw.js', output), 'utf8'),
  readFile(new URL('manifest.webmanifest', output), 'utf8'),
  readFile(new URL('_headers', output), 'utf8'),
  readFile(new URL('index.html', output), 'utf8'),
])
const manifest = JSON.parse(manifestSource)
const screenshots = await readdir(new URL('screenshots/', output))

assert.doesNotMatch(worker, /__WB_MANIFEST/, 'The Workbox manifest must be injected at build time')
assert.match(worker, /index\.html/, 'The offline shell must include index.html')
assert.match(worker, /GET_UPDATE_ACTIVATION_STATE/, 'The quiet update handshake must be bundled')
assert.match(worker, /\/api\//, 'The worker must retain the explicit API bypass')
assert.doesNotMatch(
  worker,
  /better-github-feed-shell-v3/,
  'Legacy shell caches must not be created',
)

assert.equal(manifest.id, '/')
assert.equal(manifest.display, 'standalone')
assert.equal(
  manifest.screenshots.some(screenshot => screenshot.form_factor === 'wide'),
  true,
  'A wide desktop install screenshot must be present',
)
assert.equal(
  manifest.screenshots.some(screenshot => screenshot.form_factor !== 'wide'),
  true,
  'A mobile install screenshot must be present',
)
assert.deepEqual(screenshots.sort(), ['desktop-feed.jpg', 'mobile-feed.jpg'])
assert.equal(
  manifest.icons.filter(icon => icon.purpose === 'maskable').length,
  2,
  'Both required maskable sizes must be present',
)
assert.match(headers, /\/sw\.js\n {2}Cache-Control: no-cache/)
assert.match(headers, /\/assets\/\*\n {2}Cache-Control: public, max-age=31536000, immutable/)
assert.match(index, /rel="apple-touch-icon"/)
