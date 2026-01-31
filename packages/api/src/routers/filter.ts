import { db } from '@better-github-feed/db'
import { userFilter } from '@better-github-feed/db/schema/github'
import type { FilterGroup } from '@better-github-feed/shared'
import {
  emptyFilterGroup,
  feedItemFilterSchema,
  filterFnList,
} from '@better-github-feed/shared'
import { ORPCError } from '@orpc/server'
import { and, eq } from 'drizzle-orm'

import { deserializeFilterGroup } from '../filter/drizzle-transform'
import { protectedProcedure } from '../index'

function generateId() {
  return crypto.randomUUID()
}

export const filterRouter = {
  /**
   * List all user filter rules
   */
  list: protectedProcedure.filter.list.handler(async ({ context }) => {
    const userId = context.session.user.id

    const filters = await db
      .select()
      .from(userFilter)
      .where(eq(userFilter.userId, userId))
      .orderBy(userFilter.createdAt)

    return filters.map(f => ({
      id: f.id,
      name: f.name,
      filterRule: deserializeFilterGroup(f.filterRule),
      createdAt: f.createdAt,
      updatedAt: f.updatedAt,
    }))
  }),

  /**
   * Create a new filter rule
   */
  create: protectedProcedure.filter.create.handler(async ({ context, input }) => {
    const userId = context.session.user.id

    // Validate the filterRule is valid JSON and FilterGroup
    let parsedRule: FilterGroup
    try {
      parsedRule = deserializeFilterGroup(input.body.filterRule)
    }
    catch {
      throw new ORPCError('BAD_REQUEST', { message: 'Invalid filter rule format' })
    }

    const id = generateId()
    const now = new Date()

    await db.insert(userFilter).values({
      id,
      userId,
      name: input.body.name,
      filterRule: input.body.filterRule,
      createdAt: now,
      updatedAt: now,
    })

    return {
      id,
      name: input.body.name,
      filterRule: parsedRule,
      createdAt: now,
      updatedAt: now,
    }
  }),

  /**
   * Update an existing filter rule
   */
  update: protectedProcedure.filter.update.handler(async ({ context, input }) => {
    const userId = context.session.user.id
    const filterId = input.params.id

    // Check if filter exists and belongs to user
    const existing = await db
      .select()
      .from(userFilter)
      .where(and(eq(userFilter.id, filterId), eq(userFilter.userId, userId)))
      .limit(1)

    if (existing.length === 0) {
      throw new ORPCError('NOT_FOUND', { message: 'Filter not found' })
    }

    // Validate filterRule if provided
    if (input.body.filterRule) {
      try {
        deserializeFilterGroup(input.body.filterRule)
      }
      catch {
        throw new ORPCError('BAD_REQUEST', { message: 'Invalid filter rule format' })
      }
    }

    const now = new Date()
    const updateData: { name?: string, filterRule?: string, updatedAt: Date } = {
      updatedAt: now,
    }

    if (input.body.name) {
      updateData.name = input.body.name
    }
    if (input.body.filterRule) {
      updateData.filterRule = input.body.filterRule
    }

    await db
      .update(userFilter)
      .set(updateData)
      .where(and(eq(userFilter.id, filterId), eq(userFilter.userId, userId)))

    // Fetch updated record
    const updated = await db
      .select()
      .from(userFilter)
      .where(eq(userFilter.id, filterId))
      .limit(1)

    const record = updated[0]!
    return {
      id: record.id,
      name: record.name,
      filterRule: deserializeFilterGroup(record.filterRule),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }
  }),

  /**
   * Delete a filter rule
   */
  delete: protectedProcedure.filter.delete.handler(async ({ context, input }) => {
    const userId = context.session.user.id

    const result = await db
      .delete(userFilter)
      .where(and(eq(userFilter.id, input.params.id), eq(userFilter.userId, userId)))

    if (result.meta.changes === 0) {
      throw new ORPCError('NOT_FOUND', { message: 'Filter not found' })
    }

    return { success: true }
  }),

  /**
   * Get the filter schema and available filter functions
   * Used by the frontend FilterBuilder
   */
  getSchema: protectedProcedure.filter.getSchema.handler(() => {
    return {
      schema: feedItemFilterSchema,
      filterFnList: filterFnList.map(fn => ({
        name: fn.name,
      })),
      emptyFilterGroup,
    }
  }),
}
