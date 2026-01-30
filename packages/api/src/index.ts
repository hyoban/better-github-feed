import { ORPCError, os } from '@orpc/server'

import type { Context } from './context'

const ADMIN_EMAILS = ['hi@hyoban.cc']

export const o = os.$context<Context>()

export const publicProcedure = o

const requireAuth = o.middleware(async ({ context, next }) => {
  if (!context.session?.user) {
    throw new ORPCError('UNAUTHORIZED')
  }
  return next({
    context: {
      session: context.session,
    },
  })
})

export const protectedProcedure = publicProcedure.use(requireAuth)

const requireAdmin = requireAuth.concat(async ({ context, next }) => {
  const email = context.session.user.email
  if (!email || !ADMIN_EMAILS.includes(email)) {
    throw new ORPCError('FORBIDDEN', { message: 'Admin access required' })
  }
  return next({ context })
})

export const adminProcedure = publicProcedure.use(requireAdmin)
