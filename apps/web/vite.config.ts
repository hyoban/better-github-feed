import { cloudflare } from '@cloudflare/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, lazyPlugins } from 'vite-plus'

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  plugins: lazyPlugins(() => [
    cloudflare({
      configPath: './wrangler.jsonc',
    }),
    tailwindcss(),
    react(),
  ]),
})
