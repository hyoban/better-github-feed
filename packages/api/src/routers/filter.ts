import { db } from '@better-github-feed/db'
import { ORPCError } from '@orpc/server'

import { createUserFilters, UserFilterNotFoundError } from '../filter/user-filter'
import { protectedProcedure } from '../index'

const userFilters = createUserFilters(db)

function mapUserFilterError(error: unknown): never {
  if (error instanceof UserFilterNotFoundError) {
    throw new ORPCError('NOT_FOUND', { message: error.message })
  }
  throw error
}

export const filterRouter = {
  list: protectedProcedure.filter.list.handler(({ context }) => {
    return userFilters.list(context.session.user.id)
  }),

  create: protectedProcedure.filter.create.handler(({ context, input }) => {
    return userFilters.create(context.session.user.id, input.body)
  }),

  update: protectedProcedure.filter.update.handler(async ({ context, input }) => {
    try {
      return await userFilters.update(context.session.user.id, input.params.id, input.body)
    } catch (error) {
      mapUserFilterError(error)
    }
  }),

  delete: protectedProcedure.filter.delete.handler(async ({ context, input }) => {
    try {
      return await userFilters.delete(context.session.user.id, input.params.id)
    } catch (error) {
      mapUserFilterError(error)
    }
  }),
}
