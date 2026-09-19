import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  root: 'src/web/client',
  resolve: {
    alias: [
      // Use ghostty-web's TypeScript source so Vite emits `ghostty-vt.wasm` as
      // a real same-origin asset via `new URL(..., import.meta.url)`. The
      // published `dist/ghostty-web.js` bundle inlines the WASM as a
      // `data:application/wasm` URL, which the app CSP (`connect-src 'self'`)
      // blocks and which bloats the JS bundle by ~1.3 MB. Exact match only:
      // subpath imports (e.g. `ghostty-web/ghostty-vt.wasm?url`) must keep
      // resolving through the package exports map.
      {
        find: /^ghostty-web$/,
        replacement: path.resolve(import.meta.dirname, 'node_modules/ghostty-web/lib/index.ts'),
      },
      { find: 'opencode-pty', replacement: path.resolve(import.meta.dirname, './src') },
    ],
  },
  build: {
    outDir: '../../../dist/web',
    emptyOutDir: true,
    minify: process.env.NODE_ENV === 'test' ? false : 'oxc', // Vite 8 minifies with Oxc; esbuild is no longer bundled
  },
  server: {
    port: 3000,
    host: true,
  },
})
