import { readdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as authSchema from '@better-github-feed/db/schema/auth'
import * as githubSchema from '@better-github-feed/db/schema/github'
import { drizzle } from 'drizzle-orm/d1'
import { Miniflare } from 'miniflare'

const migrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../db/src/migrations',
)
const schema = { ...authSchema, ...githubSchema }

export async function createTestDatabase() {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: { DB: crypto.randomUUID() },
  })
  const binding = await miniflare.getD1Database('DB')
  const migrationFiles = (await readdir(migrationsDirectory))
    .filter(file => file.endsWith('.sql'))
    .sort()

  for (const migrationFile of migrationFiles) {
    const migration = await readFile(resolve(migrationsDirectory, migrationFile), 'utf8')
    for (const statement of migration.split('--> statement-breakpoint')) {
      const sql = statement.trim()
      if (sql) {
        await binding.prepare(sql).run()
      }
    }
  }

  return {
    database: drizzle(binding, { schema }),
    dispose: () => miniflare.dispose(),
  }
}
