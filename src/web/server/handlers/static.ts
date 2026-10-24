import { readdirSync, statSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { ASSET_CONTENT_TYPES } from '../../shared/constants.ts'
import { SECURITY_HEADERS } from './security-headers.ts'

// Resolve project root regardless of whether we're running from source or dist/
const MODULE_DIR = resolve(import.meta.dir, '../../../..')
const PROJECT_ROOT = MODULE_DIR.replace(/[\\/]dist$/, '')
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

/**
 * An asset that the route map does not hold, read from disk.
 *
 * `buildStaticRoutes` reads `dist/web` once, at start, and keeps the files in memory.
 * `index.html` is read per request on purpose - it is what points at the content-hashed
 * assets - so a rebuild under a running server hands the browser filenames the route
 * map has never seen. The routes miss, and before this existed the miss fell through
 * to the redirect: the browser asked for a `.js` module and got `index.html`, a white
 * page and a MIME-type error, with nothing on screen to say why.
 *
 * Reading the file off disk is what makes "a new build is picked up on reload" true for
 * the assets as well as for the shell. Only `/assets/` is served this way, and only
 * below the directory: it is content-hashed output, so a miss there can only mean "a
 * newer build", and a path that tries to leave it is refused rather than normalised.
 */
async function serveAssetFromDisk(pathname: string): Promise<Response | null> {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  // `..` and a NUL are the two ways out of a directory. Checked on the decoded path,
  // because the URL parser leaves `%2e%2e` alone while `join` would honour it.
  if (decoded.includes('..') || decoded.includes('\0')) return null
  const fullPath = join(STATIC_DIR, decoded)
  if (!fullPath.startsWith(`${STATIC_DIR}/`)) return null
  const file = Bun.file(fullPath)
  if (!(await file.exists())) return null
  return new Response(await file.bytes(), {
    headers: {
      'Content-Type':
        file.type || ASSET_CONTENT_TYPES[extname(fullPath)] || 'application/octet-stream',
      'Cache-Control': IMMUTABLE_CACHE,
      ...SECURITY_HEADERS,
    },
  })
}

/**
 * The last resort, for a path no route claims.
 *
 * A missing asset is a 404 rather than the shell: a module that 404s says what is
 * wrong in one console line, while a shell answered to a `.js` request is the white
 * page this exists to end. Anything else is a path the app does not have - a stale
 * bookmark, a typo - and lands on the app itself, under its own address, so the URL a
 * reader ends up looking at is `:4200/` and not `:4200/index.html`.
 */
export async function serveStaticFallback(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url)
  if (!pathname.startsWith('/assets/')) {
    return new Response(null, { status: 302, headers: { Location: '/' } })
  }
  const asset = await serveAssetFromDisk(pathname)
  return asset ?? new Response('Not found', { status: 404, headers: SECURITY_HEADERS })
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
