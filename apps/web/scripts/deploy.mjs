import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

const secretEnvironmentNames = {
  BETTER_AUTH_URL: 'DEPLOY_BETTER_AUTH_URL',
  BETTER_AUTH_SECRET: 'DEPLOY_BETTER_AUTH_SECRET',
  BETTER_AUTH_GITHUB_CLIENT_ID: 'DEPLOY_BETTER_AUTH_GITHUB_CLIENT_ID',
  BETTER_AUTH_GITHUB_CLIENT_SECRET: 'DEPLOY_BETTER_AUTH_GITHUB_CLIENT_SECRET',
}

const configuredSecrets = Object.fromEntries(
  Object.entries(secretEnvironmentNames)
    .filter(([, environmentName]) => process.env[environmentName])
    .map(([secretName, environmentName]) => [secretName, process.env[environmentName]]),
)

if (Object.keys(configuredSecrets).length > 0
  && Object.keys(configuredSecrets).length !== Object.keys(secretEnvironmentNames).length) {
  const missingVariables = Object.entries(secretEnvironmentNames)
    .filter(([secretName]) => !configuredSecrets[secretName])
    .map(([, environmentName]) => environmentName)
  throw new Error(`Set all deployment secrets or none of them. Missing: ${missingVariables.join(', ')}`)
}

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

function runWrangler(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(pnpm, ['exec', 'wrangler', ...args], {
      env: process.env,
      stdio: 'inherit',
    })

    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve()
        return
      }

      const reason = signal ? `signal ${signal}` : `exit code ${code}`
      reject(new Error(`wrangler ${args.join(' ')} failed with ${reason}`))
    })
  })
}

let temporaryDirectory

try {
  let secretsArguments = []

  if (Object.keys(configuredSecrets).length === Object.keys(secretEnvironmentNames).length) {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'better-github-feed-'))
    const secretsFile = join(temporaryDirectory, 'secrets.json')
    await writeFile(secretsFile, JSON.stringify(configuredSecrets), { mode: 0o600 })
    secretsArguments = ['--secrets-file', secretsFile]
  }

  // Uploading a version does not change production traffic. It provisions a
  // fresh D1 binding before migrations run and validates the Worker bundle.
  await runWrangler(['versions', 'upload', ...secretsArguments])
  await runWrangler(['d1', 'migrations', 'apply', 'DB', '--remote'])
  await runWrangler(['deploy', ...secretsArguments])
}
finally {
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}
