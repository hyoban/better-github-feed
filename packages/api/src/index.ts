import { routerContract } from '@better-github-feed/contract'
import { implement, ORPCError } from '@orpc/server'

import type { Context } from './context'

const ADMIN_EMAILS = ['hi@hyoban.cc']

const os = implement(routerContract).$context<Context>()

export const publicProcedure = os

const requireAuth = os.middleware(async ({ context, next }) => {
  if (!context.session?.user) {
    throw new ORPCError('UNAUTHORIZED')
  }
  return next({
    context: {
      session: context.session,
    },
  })
})

export const protectedProcedure = os.use(requireAuth)

const requireAdmin = os.middleware(async ({ context, next }) => {
  if (!context.session?.user) {
    throw new ORPCError('UNAUTHORIZED')
  }
  const email = context.session.user.email
  if (!email || !ADMIN_EMAILS.includes(email)) {
    throw new ORPCError('FORBIDDEN', { message: 'Admin access required' })
  }
  return next({
    context: {
      session: context.session,
    },
  })
})

export const adminProcedure = os.use(requireAdmin)

export { os }
