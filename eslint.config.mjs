import { defineConfig } from 'eslint-config-hyoban'

export default defineConfig(
  {
    react: true,
    pnpm: {
      yaml: false,
    },
    tailwindcss: {
      settings: {
        entryPoint: './apps/web/src/index.css',
      },
    },
  },
  {
    files: [
      '**/components/ui/**/*.tsx',
      '**/hooks/**/*.tsx',
    ],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
)
