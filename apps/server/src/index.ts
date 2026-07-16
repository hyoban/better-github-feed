import { createContext } from '@better-github-feed/api/context'
import {
  appRouter,
  cleanupOldFeedItems,
  compactUserStateSync,
  reconcileLegacyFeedItems,
  refreshAllUsersFeeds,
  syncAllGithubFollowings,
} from '@better-github-feed/api/routers/index'
import { auth } from '@better-github-feed/auth'
import { OpenAPIHandler } from '@orpc/openapi/fetch'
import { OpenAPIReferencePlugin } from '@orpc/openapi/plugins'
import { onError } from '@orpc/server'
import { RPCHandler } from '@orpc/server/fetch'
import { ZodToJsonSchemaConverter } from '@orpc/zod/zod4'
import { Hono } from 'hono'
import { logger } from 'hono/logger'

import { runScheduledMaintenance } from './scheduled-maintenance'

const app = new Hono<{ Bindings: Env }>()

app.use(logger())

app.on(['POST', 'GET'], '/api/auth/*', c => auth.handler(c.req.raw))

async function runBackendMaintenance() {
  return runScheduledMaintenance({
    syncFollowing: syncAllGithubFollowings,
    reconcileActivity: reconcileLegacyFeedItems,
    refreshActivity: refreshAllUsersFeeds,
    cleanupActivity: cleanupOldFeedItems,
    compactUserState: compactUserStateSync,
    // oxlint-disable-next-line no-console
    log: event => console.log(JSON.stringify(event)),
    // oxlint-disable-next-line no-console
    logError: event => console.error(JSON.stringify(event)),
  })
}

if (import.meta.env.DEV) {
  app.post('/api/dev/sync', async c => {
    const context = await createContext({ context: c })
    if (!context.session?.user) return c.json({ message: 'Authentication required' }, 401)
    try {
      await runBackendMaintenance()
      return c.json({ ok: true as const })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Backend sync failed'
      return c.json({ message }, 500)
    }
  })
}

export const apiHandler = new OpenAPIHandler(appRouter, {
  plugins: [
    new OpenAPIReferencePlugin({
      schemaConverters: [new ZodToJsonSchemaConverter()],
    }),
  ],
  interceptors: [
    onError(error => {
      console.error(error)
    }),
  ],
})

export const rpcHandler = new RPCHandler(appRouter, {
  interceptors: [
    onError(error => {
      console.error(error)
    }),
  ],
})

app.use('/*', async (c, next) => {
  const requestContext = await createContext({ context: c })

  const rpcResult = await rpcHandler.handle(c.req.raw, {
    prefix: '/api/rpc',
    context: requestContext,
  })

  if (rpcResult.matched) {
    return c.newResponse(rpcResult.response.body, rpcResult.response)
  }

  const apiResult = await apiHandler.handle(c.req.raw, {
    prefix: '/api/reference',
    context: requestContext,
  })

  if (apiResult.matched) {
    return c.newResponse(apiResult.response.body, apiResult.response)
  }

  await next()
})

app.get('/api/health', c => {
  return c.text('OK')
})

export default {
  fetch: app.fetch,
  async scheduled(controller) {
    // oxlint-disable-next-line no-console
    console.log(
      JSON.stringify({
        message: 'cron_triggered',
        cron: controller.cron,
        scheduledTime: controller.scheduledTime,
      }),
    )

    await runBackendMaintenance()
  },
} satisfies ExportedHandler<Env>
