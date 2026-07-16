import { cloudflare } from '@cloudflare/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, lazyPlugins } from 'vite-plus'
import { VitePWA } from 'vite-plugin-pwa'

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
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src/service-worker',
      filename: 'sw.js',
      injectRegister: false,
      manifest: false,
      injectManifest: {
        globPatterns: ['**/*.{css,html,ico,js,png,svg,webmanifest}'],
        injectionPoint: 'globalThis.__WB_MANIFEST',
        maximumFileSizeToCacheInBytes: 2 * 1024 * 1024,
      },
    }),
  ]),
})
