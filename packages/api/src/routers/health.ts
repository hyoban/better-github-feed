import { publicProcedure } from '../index'

export const healthRouter = {
  check: publicProcedure.health.check.handler(() => {
    return 'OK'
  }),
}
