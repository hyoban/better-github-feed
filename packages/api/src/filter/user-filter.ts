import type { Database } from '@better-github-feed/db'
import { userFilter } from '@better-github-feed/db/schema/github'
import type { FilterGroup } from '@better-github-feed/shared'
import { filterGroupSchema } from '@better-github-feed/shared'
import { and, eq, isNull } from 'drizzle-orm'

import { deserializeFilterGroup } from './drizzle-transform'
import { createLocalFeedSync } from '../local-feed/local-feed-sync'

export class UserFilterNotFoundError extends Error {
  constructor() {
    super('User Filter not found')
    this.name = 'UserFilterNotFoundError'
  }
}

export function createUserFilters(database: Database) {
  const localFeedSync = createLocalFeedSync({ database })

  return {
    async create(userId: string, input: { name: string; filterRule: FilterGroup }) {
      const filterRule = filterGroupSchema.parse(input.filterRule)
      const id = crypto.randomUUID()
      const result = await localFeedSync.applyLegacyUserMutation(userId, {
        kind: 'filter.put',
        mutationId: crypto.randomUUID(),
        attemptId: crypto.randomUUID(),
        baseVersion: 0,
        filter: { id, name: input.name, filterRule },
      })
      if (result.kind === 'conflict' || result.entityKind !== 'filter') {
        throw new Error('User Filter create conflicted')
      }

      return {
        id: result.replica.id,
        userId,
        name: result.replica.name,
        createdAt: new Date(result.replica.createdAt),
        updatedAt: new Date(result.replica.updatedAt),
        isValid: true as const,
        filterRule: filterGroupSchema.parse(result.replica.filterRule),
      }
    },

    async list(userId: string) {
      const rows = await database
        .select()
        .from(userFilter)
        .where(and(eq(userFilter.userId, userId), isNull(userFilter.deletedAt)))
        .orderBy(userFilter.createdAt)

      return rows.map(row => {
        try {
          return {
            ...row,
            isValid: true as const,
            filterRule: deserializeFilterGroup(row.filterRule),
          }
        } catch {
          return {
            ...row,
            isValid: false as const,
            filterRule: null,
          }
        }
      })
    },

    async update(userId: string, id: string, input: { name?: string; filterRule?: FilterGroup }) {
      const existing = await database
        .select()
        .from(userFilter)
        .where(
          and(eq(userFilter.id, id), eq(userFilter.userId, userId), isNull(userFilter.deletedAt)),
        )
        .limit(1)
      if (!existing[0]) {
        throw new UserFilterNotFoundError()
      }

      const filterRule = input.filterRule ? filterGroupSchema.parse(input.filterRule) : undefined
      const row = existing[0]
      const result = await localFeedSync.applyLegacyUserMutation(userId, {
        kind: 'filter.put',
        mutationId: crypto.randomUUID(),
        attemptId: crypto.randomUUID(),
        baseVersion: row.entityVersion,
        filter: {
          id,
          name: input.name ?? row.name,
          filterRule: filterRule ?? deserializeFilterGroup(row.filterRule),
        },
      })
      if (result.kind === 'conflict' || result.entityKind !== 'filter') {
        throw new Error('User Filter update conflicted')
      }
      return {
        id: result.replica.id,
        userId,
        name: result.replica.name,
        createdAt: new Date(result.replica.createdAt),
        updatedAt: new Date(result.replica.updatedAt),
        isValid: true as const,
        filterRule: filterGroupSchema.parse(result.replica.filterRule),
      }
    },

    async delete(userId: string, id: string) {
      const rows = await database
        .select({ version: userFilter.entityVersion })
        .from(userFilter)
        .where(
          and(eq(userFilter.id, id), eq(userFilter.userId, userId), isNull(userFilter.deletedAt)),
        )
        .limit(1)
      const current = rows[0]
      if (!current) {
        throw new UserFilterNotFoundError()
      }
      const result = await localFeedSync.applyLegacyUserMutation(userId, {
        kind: 'filter.delete',
        mutationId: crypto.randomUUID(),
        attemptId: crypto.randomUUID(),
        baseVersion: current.version,
        id,
      })
      if (result.kind === 'conflict') {
        throw new UserFilterNotFoundError()
      }
      return { success: true as const }
    },
  }
}
