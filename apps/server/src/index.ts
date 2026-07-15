import { createContext } from '@better-github-feed/api/context'
import {
  appRouter,
  cleanupOldFeedItems,
  refreshAllUsersFeeds,
} from '@better-github-feed/api/routers/index'
import { auth } from '@better-github-feed/auth'
import { OpenAPIHandler } from '@orpc/openapi/fetch'
import { OpenAPIReferencePlugin } from '@orpc/openapi/plugins'
import { onError } from '@orpc/server'
import { RPCHandler } from '@orpc/server/fetch'
import { ZodToJsonSchemaConverter } from '@orpc/zod/zod4'
import { Hono } from 'hono'
import { logger } from 'hono/logger'

const app = new Hono<{ Bindings: Env }>()

app.use(logger())

app.on(['POST', 'GET'], '/api/auth/*', c => auth.handler(c.req.raw))

export const apiHandler = new OpenAPIHandler(appRouter, {
  plugins: [
    new OpenAPIReferencePlugin({
      schemaConverters: [new ZodToJsonSchemaConverter()],
    }),
  ],
  interceptors: [
    onError((error) => {
      console.error(error)
    }),
  ],
})

export const rpcHandler = new RPCHandler(appRouter, {
  interceptors: [
    onError((error) => {
      console.error(error)
    }),
  ],
})

app.use('/*', async (c, next) => {
  // eslint-disable-next-line react-naming-convention/context-name
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

app.get('/api/health', (c) => {
  return c.text('OK')
})

export default {
  fetch: app.fetch,
  async scheduled(controller) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      message: 'cron_triggered',
      cron: controller.cron,
      scheduledTime: controller.scheduledTime,
    }))

    const refreshResults = await refreshAllUsersFeeds()
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ message: 'refresh_completed', results: refreshResults }))

    const cleanupResults = await cleanupOldFeedItems()
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ message: 'cleanup_completed', results: cleanupResults }))
  },
} satisfies ExportedHandler<Env>
