# Better GitHub Feed

A modern web application that turns the activity of the developers you follow on GitHub into a unified, filterable feed.

## Features

- **GitHub Feed Aggregation** - Collect activity from the developers you follow
- **Advanced Filtering** - Focus on the events that matter to you
- **GitHub Following Sync** - Keep the feed aligned with your GitHub following list
- **Scheduled Refresh** - Sync following lists and refresh feeds every 20 minutes with a Cron Trigger
- **GitHub OAuth** - Authenticate securely with GitHub
- **Responsive UI** - Use the feed comfortably on desktop and mobile

## Architecture

The application is deployed as one Cloudflare Worker:

- React 19, React Router, Tailwind CSS, and Vite for the SPA
- Hono and oRPC for the API
- Better Auth with GitHub OAuth
- Cloudflare D1 with Drizzle ORM
- Workers Static Assets for the frontend
- A Worker Cron Trigger for background refreshes

The SPA and API share one origin. API routes live under `/api/*`, while every other navigation request falls back to the SPA.

## Prerequisites

Install the Vite+ CLI, then open a new terminal:

```sh
curl -fsSL https://vite.plus | bash
vp help
```

On Windows, install it from PowerShell with `irm https://vite.plus/ps1 | iex`. Vite+ reads the repository's `.node-version` and manages the matching Node.js runtime automatically.

## Local Development

Install dependencies:

```sh
vp install
```

Copy the local secrets template:

```sh
cp apps/web/.dev.vars.example apps/web/.dev.vars
```

Fill in these values:

```dotenv
BETTER_AUTH_URL=http://localhost:5173
BETTER_AUTH_SECRET=<openssl rand -base64 32>
BETTER_AUTH_GITHUB_CLIENT_ID=<github-oauth-client-id>
BETTER_AUTH_GITHUB_CLIENT_SECRET=<github-oauth-client-secret>
```

Create a development GitHub OAuth App with this callback URL:

```txt
http://localhost:5173/api/auth/callback/github
```

Start the application:

```sh
vp run dev
```

Wrangler creates a local D1 database, applies pending migrations, and Vite serves both the SPA and Worker at [http://localhost:5173](http://localhost:5173).

## Deploy from a GitHub Repository

The repository is ready for Cloudflare Workers Builds and does not need a separate GitHub Actions workflow.

1. In Cloudflare, open **Workers & Pages**, select **Create application**, then **Import a repository**.
2. Select this repository and use the following settings:

   ```txt
   Worker name: better-github-feed
   Production branch: main
   Root directory: apps/web
   Build command: pnpm build
   Deploy command: pnpm run deploy
   ```

   If this account already contains the Alchemy deployment, complete [Migrating an Existing Alchemy Deployment](#migrating-an-existing-alchemy-deployment) before selecting **Save and Deploy**.

3. In **Build variables and secrets**, add `DEPLOY_BETTER_AUTH_URL` as a variable and the other three values as encrypted build secrets:

   ```txt
   DEPLOY_BETTER_AUTH_URL=https://better-github-feed.<workers-subdomain>.workers.dev
   DEPLOY_BETTER_AUTH_SECRET=<openssl rand -base64 32>
   DEPLOY_BETTER_AUTH_GITHUB_CLIENT_ID=<github-oauth-client-id>
   DEPLOY_BETTER_AUTH_GITHUB_CLIENT_SECRET=<github-oauth-client-secret>
   ```

   The `DEPLOY_` prefix prevents Vite from treating these values as application runtime variables. The deployment script maps them to the corresponding encrypted Worker secrets; they are never stored in the repository or printed in build logs.

4. Select a custom user API token with at least **Workers Scripts: Edit**, **D1: Edit**, and the standard account/user read permissions. The default Workers Builds token does not currently include D1 access.
5. Create a production GitHub OAuth App. For a Worker deployed at `https://better-github-feed.<workers-subdomain>.workers.dev`, configure:

   ```txt
   Homepage URL:
   https://better-github-feed.<workers-subdomain>.workers.dev

   Authorization callback URL:
   https://better-github-feed.<workers-subdomain>.workers.dev/api/auth/callback/github
   ```

6. Select **Save and Deploy**. Disable non-production branch deployments unless you configure a separate preview D1 database and OAuth App. Preview versions otherwise share the production bindings.

The deploy script first uploads an inactive Worker version so Wrangler can provision and bind a new D1 database without changing production traffic. It then applies migrations from `packages/db/src/migrations` and publishes the SPA and API together with the 20-minute Cron Trigger.

### Migrating an Existing Alchemy Deployment

Do not run the old `pnpm destroy` command. It can delete the production D1 database.

Before the first Wrangler deployment, copy the existing D1 database ID from the Cloudflare dashboard into the `DB` binding in `apps/web/wrangler.jsonc`:

```jsonc
{
  "binding": "DB",
  "database_name": "better-github-feed-database-prod",
  "database_id": "<existing-d1-database-id>",
  "migrations_dir": "../../packages/db/src/migrations",
}
```

Wrangler uses the same `d1_migrations` table as the previous deployment and only applies pending migrations. After the combined Worker is verified, remove the old Web and Server Workers separately so the old Cron Trigger cannot continue running.

## Project Structure

```txt
better-github-feed/
├── apps/
│   ├── web/           # React SPA and Cloudflare Vite build
│   │   └── wrangler.jsonc # Worker, assets, D1, secrets, and Cron configuration
│   └── server/        # Hono Worker entrypoint
├── packages/
│   ├── api/           # API routers and business logic
│   ├── auth/          # Better Auth configuration
│   ├── config/        # Shared TypeScript configuration
│   ├── contract/      # oRPC contracts
│   ├── db/            # Drizzle schema and D1 migrations
│   ├── env/           # Typed Cloudflare binding access
│   └── shared/        # Shared types and utilities
```

## Scripts

- `vp run dev` - Apply local migrations and start the full application
- `vp check` - Format, lint, and type-check the workspace
- `vp test` - Run the Vitest test suite
- `vp run build` - Build the SPA and Worker deployment bundle
- `vp run preview` - Preview the production bundle locally
- `vp run db:generate` - Generate a new Drizzle migration
- `vp run db:migrate:local` - Apply migrations to local D1
- `vp run db:migrate:remote` - Apply migrations to production D1
- `vp run deploy` - Provision bindings, apply production migrations, and deploy the built Worker
- `vp run cf-typegen` - Regenerate Cloudflare runtime and binding types
