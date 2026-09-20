import { readdirSync, statSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { ASSET_CONTENT_TYPES } from '../../shared/constants.ts'

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
  // `connect-src data:` is needed. All scripts and styles are emitted as
  // external same-origin assets, so `'unsafe-inline'` is not needed anywhere.
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self';",
} as const
const STATIC_DIR = join(PROJECT_ROOT, 'dist/web')
const INDEX_HTML = join(STATIC_DIR, 'index.html')

/** Content-hashed build output: safe to cache forever. */
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable'
/** Anything else static (favicon, ...): cache briefly, revalidate often. */
const SHORT_CACHE = 'public, max-age=300'
/**
 * `index.html` must never be cached hard: it is what points at the hashed
 * assets, so an immutable copy keeps a browser on an old build until its cache
 * expires - the deployed UI looked stale even though the new bundle was served.
 */
const HTML_CACHE = 'no-cache'

export function cacheControlFor(routeKey: string): string {
  return routeKey.startsWith('/assets/') ? IMMUTABLE_CACHE : SHORT_CACHE
}

/**
 * Serve `index.html` from disk on every request (it is tiny), so a new build
 * takes effect on the next reload instead of the next server restart.
 */
export async function serveIndexHtml(): Promise<Response> {
  const file = Bun.file(INDEX_HTML)
  if (!(await file.exists())) {
    return new Response('Not found', { status: 404, headers: SECURITY_HEADERS })
  }

  return new Response(await file.bytes(), {
    headers: {
      'Content-Type': 'text/html;charset=utf-8',
      'Cache-Control': HTML_CACHE,
      ...SECURITY_HEADERS,
    },
  })
}

export async function buildStaticRoutes(): Promise<Record<string, Response>> {
  const routes: Record<string, Response> = {}
  const files = readdirSync(STATIC_DIR, { recursive: true })
  for (const file of files) {
    if (typeof file === 'string' && !statSync(join(STATIC_DIR, file)).isDirectory()) {
      const ext = extname(file)
      const routeKey = `/${file.replace(/\\/g, '/')}` // e.g., /assets/js/bundle.js
      // HTML is served per request (see serveIndexHtml) with a revalidating
      // cache header instead of being frozen into the route map.
      if (ext === '.html') {
        continue
      }

      const fullPath = join(STATIC_DIR, file)
      const fileObj = Bun.file(fullPath)
      const contentType = fileObj.type || ASSET_CONTENT_TYPES[ext] || 'application/octet-stream'

      // Buffer all files in memory
      routes[routeKey] = new Response(await fileObj.bytes(), {
        headers: {
          'Content-Type': contentType,
          'Cache-Control': cacheControlFor(routeKey),
          ...SECURITY_HEADERS,
        },
      })
    }
  }
  return routes
}
