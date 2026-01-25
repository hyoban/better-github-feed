import { db } from "@better-github-feed/db";
import * as schema from "@better-github-feed/db/schema/auth";
import { env } from "@better-github-feed/env/server";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "sqlite",
    schema: schema,
  }),
  trustedOrigins: [env.CORS_ORIGIN],
  socialProviders: {
    github: {
      clientId: env.BETTER_AUTH_GITHUB_CLIENT_ID,
      clientSecret: env.BETTER_AUTH_GITHUB_CLIENT_SECRET,
    },
  },
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,

  // uncomment crossSubDomainCookies setting when ready to deploy and replace <your-workers-subdomain> with your actual workers subdomain
  // https://developers.cloudflare.com/workers/wrangler/configuration/#workersdev
  crossSubDomainCookies: {
    enabled: true,
    domain: ".hyoban.workers.dev",
  },
});
