import type { Database } from '@better-github-feed/db'
import { userFilter } from '@better-github-feed/db/schema/github'
import type { FilterGroup } from '@better-github-feed/shared'
import { filterGroupSchema } from '@better-github-feed/shared'
import { and, eq } from 'drizzle-orm'

import { deserializeFilterGroup, serializeFilterGroup } from './drizzle-transform'

export class UserFilterNotFoundError extends Error {
  constructor() {
    super('User Filter not found')
    this.name = 'UserFilterNotFoundError'
  }
}

export function createUserFilters(database: Database) {
  return {
    async create(userId: string, input: { name: string; filterRule: FilterGroup }) {
      const filterRule = filterGroupSchema.parse(input.filterRule)
      const now = new Date()
      const row = {
        id: crypto.randomUUID(),
        userId,
        name: input.name,
        filterRule: serializeFilterGroup(filterRule),
        createdAt: now,
        updatedAt: now,
      }

      await database.insert(userFilter).values(row)

      return {
        ...row,
        isValid: true as const,
        filterRule,
      }
    },

    async list(userId: string) {
      const rows = await database
        .select()
        .from(userFilter)
        .where(eq(userFilter.userId, userId))
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
        .where(and(eq(userFilter.id, id), eq(userFilter.userId, userId)))
        .limit(1)
      if (!existing[0]) {
        throw new UserFilterNotFoundError()
      }

      const filterRule = input.filterRule ? filterGroupSchema.parse(input.filterRule) : undefined
      const updatedAt = new Date()
      await database
        .update(userFilter)
        .set({
          name: input.name,
          filterRule: filterRule ? serializeFilterGroup(filterRule) : undefined,
          updatedAt,
        })
        .where(and(eq(userFilter.id, id), eq(userFilter.userId, userId)))

      const row = existing[0]
      return {
        ...row,
        name: input.name ?? row.name,
        updatedAt,
        isValid: true as const,
        filterRule: filterRule ?? deserializeFilterGroup(row.filterRule),
      }
    },

    async delete(userId: string, id: string) {
      const result = await database
        .delete(userFilter)
        .where(and(eq(userFilter.id, id), eq(userFilter.userId, userId)))
      if (result.meta.changes === 0) {
        throw new UserFilterNotFoundError()
      }
      return { success: true as const }
    },
  }
}
