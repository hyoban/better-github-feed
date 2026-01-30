/// <reference path="../env.d.ts" />
// For Cloudflare Workers, env is accessed via cloudflare:workers module
// Types are defined in env.d.ts based on your alchemy.run.ts bindings
// @ts-ignore - cloudflare:workers module type availability depends on consumer's tsconfig
export { env } from "cloudflare:workers";
