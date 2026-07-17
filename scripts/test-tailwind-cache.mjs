import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cacheDirectory = mkdtempSync(join(tmpdir(), 'better-tailwindcss-cache-test-'))
const fixtureRoot = resolve(root, 'apps/web/.tmp')
mkdirSync(fixtureRoot, { recursive: true })
const fixtureDirectory = mkdtempSync(join(fixtureRoot, 'tailwind-cache-'))

try {
  const failOpen = runLint({
    BETTER_TAILWINDCSS_PERSISTENT_CACHE_DIR:
      process.platform === 'win32' ? 'NUL\\invalid' : '/dev/null/invalid',
  })
  assert.equal(failOpen.status, 0, failOpen.stderr)

  const cold = runLint({
    BETTER_TAILWINDCSS_CACHE_DEBUG: '1',
    BETTER_TAILWINDCSS_PERSISTENT_CACHE_DIR: cacheDirectory,
  })
  assert.equal(cold.status, 0, cold.stderr)

  const warm = runLint({
    BETTER_TAILWINDCSS_CACHE_DEBUG: '1',
    BETTER_TAILWINDCSS_PERSISTENT_CACHE_DIR: cacheDirectory,
  })
  assert.equal(warm.status, 0, warm.stderr)
  assert.equal(count(warm.stderr, ' miss '), 0, 'warm cache should have no misses')
  assert.ok(count(warm.stderr, ' hit ') > 0, 'warm cache should have hits')

  let cachePath = findCacheFile()
  const poisoned = JSON.parse(readFileSync(cachePath, 'utf8'))
  for (const key of Object.keys(poisoned.entries)) {
    poisoned.entries[key] = {
      operation: 'getCanonicalClasses',
      value: {
        canonicalClasses: { unsafe: { input: 'invalid', output: 1 } },
        warnings: [],
      },
    }
  }
  writeFileSync(cachePath, JSON.stringify(poisoned))
  const poisonRecovery = runLint({
    BETTER_TAILWINDCSS_PERSISTENT_CACHE_DIR: cacheDirectory,
  })
  assert.equal(poisonRecovery.status, 0, poisonRecovery.stderr)

  rmSync(cachePath)
  writeFileSync(
    `${cachePath}.lock`,
    JSON.stringify({ createdAt: Number.MAX_SAFE_INTEGER, pid: 99_999_999 }),
    { mode: 0o600 },
  )
  const staleLockRecovery = runLint({
    BETTER_TAILWINDCSS_PERSISTENT_CACHE_DIR: cacheDirectory,
  })
  assert.equal(staleLockRecovery.status, 0, staleLockRecovery.stderr)
  cachePath = findCacheFile()

  rmSync(cachePath)
  const [concurrentA, concurrentB] = await Promise.all([
    runLintAsync(cacheDirectory),
    runLintAsync(cacheDirectory),
  ])
  assert.equal(concurrentA.code, 0, concurrentA.stderr)
  assert.equal(concurrentB.code, 0, concurrentB.stderr)
  const afterConcurrentWrites = runLint({
    BETTER_TAILWINDCSS_CACHE_DEBUG: '1',
    BETTER_TAILWINDCSS_PERSISTENT_CACHE_DIR: cacheDirectory,
  })
  assert.equal(afterConcurrentWrites.status, 0, afterConcurrentWrites.stderr)
  assert.equal(
    count(afterConcurrentWrites.stderr, ' miss '),
    0,
    'concurrent writers should preserve all entries',
  )

  await testDependencyInvalidation()

  if (process.platform !== 'win32') {
    const unsafeDirectory = mkdtempSync(join(tmpdir(), 'better-tailwindcss-unsafe-'))
    try {
      chmodSync(unsafeDirectory, 0o755)
      const unsafeDirectoryResult = runLint({
        BETTER_TAILWINDCSS_PERSISTENT_CACHE_DIR: unsafeDirectory,
      })
      assert.equal(unsafeDirectoryResult.status, 0, unsafeDirectoryResult.stderr)
      assert.equal(
        readdirSync(unsafeDirectory).some(name => name.endsWith('.json')),
        false,
        'unsafe cache directories must be ignored',
      )
    } finally {
      rmSync(unsafeDirectory, { force: true, recursive: true })
    }
  }

  console.warn('Tailwind cache integration tests passed')
} finally {
  rmSync(cacheDirectory, { force: true, recursive: true })
  rmSync(fixtureDirectory, { force: true, recursive: true })
}

function runLint(extraEnvironment) {
  return spawnSync('vp', ['lint', '--silent'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...extraEnvironment },
  })
}

function runLintAsync(directory) {
  return new Promise(resolveResult => {
    const child = spawn('vp', ['lint', '--silent'], {
      cwd: root,
      env: {
        ...process.env,
        BETTER_TAILWINDCSS_PERSISTENT_CACHE_DIR: directory,
      },
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => {
      stderr += chunk
    })
    child.on('close', code => resolveResult({ code, stderr }))
    child.on('error', error => resolveResult({ code: null, stderr: String(error) }))
  })
}

function findCacheFile() {
  const cacheFile = readdirSync(cacheDirectory).find(name => name.endsWith('.json'))
  assert.ok(cacheFile, 'cache file should exist')
  return join(cacheDirectory, cacheFile)
}

function count(value, needle) {
  return value.split(needle).length - 1
}

async function testDependencyInvalidation() {
  const entryPath = join(fixtureDirectory, 'entry.css')
  const componentsPath = join(fixtureDirectory, 'components.css')
  const themePath = join(fixtureDirectory, 'theme.css')
  const pluginPath = join(fixtureDirectory, 'plugin.js')
  const baseTsconfigPath = join(fixtureDirectory, 'tsconfig.base.json')
  const tsconfigPath = join(fixtureDirectory, 'tsconfig.json')
  writeFileSync(themePath, '@theme { --color-brand: red; }')
  writeFileSync(componentsPath, '@layer components { .cache-a {} }')
  writeFileSync(pluginPath, 'export default function plugin() {}')
  writeFileSync(baseTsconfigPath, JSON.stringify({ compilerOptions: {} }))
  writeFileSync(tsconfigPath, JSON.stringify({ extends: './tsconfig.base.json' }))
  writeFileSync(
    entryPath,
    '@import "tailwindcss";\n@import "./theme.css";\n@import "./components.css";\n@plugin "./plugin.js";',
  )

  const { createTailwindContext } =
    await import('../node_modules/eslint-plugin-better-tailwindcss/lib/tailwindcss/context.async.v4.js')
  const { getCustomComponentClasses } =
    await import('../node_modules/eslint-plugin-better-tailwindcss/lib/tailwindcss/custom-component-classes.async.v4.js')
  const { CACHE_SCHEMA } =
    await import('../node_modules/eslint-plugin-better-tailwindcss/lib/async-utils/persistent-cache.js')
  const { createContextFingerprint } =
    await import('../node_modules/eslint-plugin-better-tailwindcss/lib/async-utils/persistent-cache/fingerprint.js')
  const context = {
    cwd: fixtureDirectory,
    tailwindConfigPath: entryPath,
    tsconfigPath,
    version: { major: 4, minor: 1, patch: 0 },
    warnings: [],
  }

  const initialFingerprint = createContextFingerprint(context, CACHE_SCHEMA)?.fingerprint
  const initialDesign = await createTailwindContext(context)
  const initialComponentClasses = await getCustomComponentClasses(context)
  assert.ok(initialComponentClasses.includes('cache-a'))

  writeFileSync(componentsPath, '@layer components { .cache-b {} }')
  const changedComponentClasses = await getCustomComponentClasses(context)
  assert.ok(changedComponentClasses.includes('cache-b'))
  assert.equal(changedComponentClasses.includes('cache-a'), false)

  writeFileSync(themePath, '@theme { --color-brand: blue; }')
  const cssFingerprint = createContextFingerprint(context, CACHE_SCHEMA)?.fingerprint
  const changedDesign = await createTailwindContext(context)
  assert.notEqual(initialFingerprint, cssFingerprint)
  assert.notEqual(initialDesign, changedDesign)

  writeFileSync(pluginPath, 'export default function plugin() { return 1 }')
  const pluginFingerprint = createContextFingerprint(context, CACHE_SCHEMA)?.fingerprint
  assert.notEqual(cssFingerprint, pluginFingerprint)

  writeFileSync(baseTsconfigPath, JSON.stringify({ compilerOptions: { strict: true } }))
  const tsconfigFingerprint = createContextFingerprint(context, CACHE_SCHEMA)?.fingerprint
  assert.notEqual(pluginFingerprint, tsconfigFingerprint)
}
