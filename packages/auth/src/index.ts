import { db } from '@better-github-feed/db'
import * as schema from '@better-github-feed/db/schema/auth'
import { env } from '@better-github-feed/env/server'
import { betterAuth } from 'better-auth'
import { APIError, createAuthMiddleware, getAuthoritativeSessionFromCtx } from 'better-auth/api'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'

import {
  expectedSessionTokenMatches,
  expectedSignOutMatches,
  readExpectedSignOutProof,
} from './expected-sign-out'

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: 'sqlite',
    schema,
  }),
  socialProviders: {
    github: {
      clientId: env.BETTER_AUTH_GITHUB_CLIENT_ID,
      clientSecret: env.BETTER_AUTH_GITHUB_CLIENT_SECRET,
    },
  },
  account: {
    accountLinking: {
      enabled: false,
      disableImplicitLinking: true,
    },
  },
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  hooks: {
    before: createAuthMiddleware(async context => {
      if (context.path !== '/revoke-session') return
      const headers = context.request?.headers ?? context.headers
      const proof = headers ? readExpectedSignOutProof(headers) : null
      if (!proof) {
        throw new APIError('BAD_REQUEST', {
          message: 'Expected account sign-out proof is required',
        })
      }
      const session = await getAuthoritativeSessionFromCtx(context)
      if (!session) return
      const accounts = await context.context.internalAdapter.findAccounts(session.user.id)
      if (!expectedSignOutMatches(proof, session.session, accounts)) {
        throw new APIError('CONFLICT', {
          message: 'The authenticated account changed before sign out completed',
        })
      }
      if (!expectedSessionTokenMatches(context.body?.token, session.session.token)) {
        throw new APIError('CONFLICT', {
          message: 'The expected session token changed before sign out completed',
        })
      }
    }),
  },
})
