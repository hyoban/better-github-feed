# Better GitHub Feed

A modern web application that aggregates GitHub developer activity into a unified, filterable feed. Track the open-source contributions of developers you follow and discover interesting projects through their activity.

## Features

- **GitHub Feed Aggregation** - Collect and display activity from multiple GitHub developers in one place
- **Advanced Filtering** - Custom filter rules to focus on the events that matter to you
- **Subscription Management** - Subscribe to developers with OPML import/export support
- **Real-time Refresh** - Keep your feed up-to-date with the latest activity
- **GitHub OAuth** - Secure authentication via GitHub
- **Responsive UI** - Desktop sidebar and mobile drawer for seamless experience across devices

## Tech Stack

### Frontend

- React 19 with React Router
- TailwindCSS + shadcn/ui
- TanStack Query for data fetching
- Vite for development and builds

### Backend

- Hono - Lightweight web framework
- oRPC - End-to-end type-safe APIs with OpenAPI integration
- Cloudflare Workers runtime

### Database

- Drizzle ORM
- SQLite/Turso (D1)

### Auth

- Better-Auth with GitHub OAuth

### Infrastructure

- Alchemy for Cloudflare Workers deployment

## Getting Started

First, install the dependencies:

```sh
pnpm install
```

## Database Setup

This project uses SQLite with Drizzle ORM.

1. D1 local development and migrations are handled automatically by Alchemy during dev and deploy.

2. Update your `.env` file in the `apps/server` directory with the appropriate connection details if needed.

3. Apply the schema to your database:

```sh
pnpm db:push
```

Then, run the development server:

```sh
pnpm dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser to see the web application.
The API is running at [http://localhost:3000](http://localhost:3000).

## Deployment (Cloudflare via Alchemy)

- Dev: `pnpm dev`
- Deploy: `pnpm deploy`
- Destroy: `pnpm destroy`

For more details, see the guide on [Deploying to Cloudflare with Alchemy](https://www.better-t-stack.dev/docs/guides/cloudflare-alchemy).

## Project Structure

```txt
better-github-feed/
├── apps/
│   ├── web/           # Frontend application (React + React Router)
│   └── server/        # Backend API (Hono, oRPC)
├── packages/
│   ├── api/           # API layer / business logic
│   ├── auth/          # Authentication configuration & logic
│   ├── config/        # Shared ESLint/TypeScript configuration
│   ├── contract/      # oRPC API contracts
│   ├── db/            # Database schema & queries
│   ├── env/           # Environment variable management
│   ├── infra/         # Deployment infrastructure (Alchemy)
│   └── shared/        # Shared types and utilities
```

## Available Scripts

- `pnpm dev` - Start all applications in development mode
- `pnpm build` - Build all applications
- `pnpm dev:web` - Start only the web application
- `pnpm dev:server` - Start only the server
- `pnpm type-check` - Check TypeScript types across all apps
- `pnpm lint` - Run ESLint
- `pnpm lint:fix` - Run ESLint with auto-fix
- `pnpm db:push` - Push schema changes to database
- `pnpm db:generate` - Generate database migrations
