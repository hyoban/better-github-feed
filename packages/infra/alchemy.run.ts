import alchemy from "alchemy";
import { ReactRouter } from "alchemy/cloudflare";
import { Worker } from "alchemy/cloudflare";
import { D1Database } from "alchemy/cloudflare";
import { CloudflareStateStore } from "alchemy/state";
import { config } from "dotenv";

const isProduction = process.env.NODE_ENV === "production";
const isDevelopment = process.env.NODE_ENV === "development";

config({ path: "./.env" + (isProduction ? ".prod" : "") });
config({ path: "../../apps/web/.env" + (isProduction ? ".prod" : "") });
config({ path: "../../apps/server/.env" + (isProduction ? ".prod" : "") });

const app = await alchemy("better-github-feed", {
  stateStore: isDevelopment ? undefined : (scope) => new CloudflareStateStore(scope),
});

const db = await D1Database("database", {
  migrationsDir: "../../packages/db/src/migrations",
});

export const web = await ReactRouter("web", {
  cwd: "../../apps/web",
  bindings: {
    VITE_SERVER_URL: alchemy.env.VITE_SERVER_URL!,
  },
});

export const server = await Worker("server", {
  cwd: "../../apps/server",
  entrypoint: "src/index.ts",
  compatibility: "node",
  bindings: {
    DB: db,
    CORS_ORIGIN: alchemy.env.CORS_ORIGIN!,
    BETTER_AUTH_SECRET: alchemy.secret.env.BETTER_AUTH_SECRET!,
    BETTER_AUTH_URL: alchemy.env.BETTER_AUTH_URL!,
    BETTER_AUTH_GITHUB_CLIENT_ID: alchemy.env.BETTER_AUTH_GITHUB_CLIENT_ID!,
    BETTER_AUTH_GITHUB_CLIENT_SECRET: alchemy.secret.env.BETTER_AUTH_GITHUB_CLIENT_SECRET!,
  },
  crons: ["*/5 * * * *"], // Run every 5 minutes
  dev: {
    port: 3000,
  },
});

console.log(`Web    -> ${web.url}`);
console.log(`Server -> ${server.url}`);

await app.finalize();
