import { readdirSync, statSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { ASSET_CONTENT_TYPES } from '../../shared/constants.ts'

// ----- MODULE-SCOPE CONSTANTS -----
// Resolve project root regardless of whether we're running from source or dist/
const MODULE_DIR = resolve(import.meta.dir, '../../../..')
const PROJECT_ROOT = MODULE_DIR.replace(/[\\/]dist$/, '')
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-XSS-Protection': '1; mode=block',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  // `script-src` keeps `'wasm-unsafe-eval'` (Chromium and Firefox require it to
  // compile the ghostty-web WebAssembly module; it does NOT enable JS `eval`).
  // The WASM is served as a same-origin asset under `default-src 'self'`, so no
  // `connect-src data:` is needed. `'unsafe-inline'` is gone from `script-src`
  // because the built index.html has no inline scripts; `style-src` keeps it
  // for the inline <style> in index.html (Vite's bundled CSS).
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline';",
} as const
const STATIC_DIR = join(PROJECT_ROOT, 'dist/web')

export async function buildStaticRoutes(): Promise<Record<string, Response>> {
  const routes: Record<string, Response> = {}
  const files = readdirSync(STATIC_DIR, { recursive: true })
  for (const file of files) {
    if (typeof file === 'string' && !statSync(join(STATIC_DIR, file)).isDirectory()) {
      const ext = extname(file)
      const routeKey = `/${file.replace(/\\/g, '/')}` // e.g., /assets/js/bundle.js
      const fullPath = join(STATIC_DIR, file)
      const fileObj = Bun.file(fullPath)
      const contentType = fileObj.type || ASSET_CONTENT_TYPES[ext] || 'application/octet-stream'

      // Buffer all files in memory
      routes[routeKey] = new Response(await fileObj.bytes(), {
        headers: {
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=31536000, immutable',
          ...SECURITY_HEADERS,
        },
      })
    }
  }
  return routes
}
