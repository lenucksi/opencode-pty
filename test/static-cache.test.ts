import { describe, expect, it } from 'bun:test'

import {
  buildStaticRoutes,
  cacheControlFor,
  serveIndexHtml,
} from '../src/web/server/handlers/static.ts'

/**
 * A hard-cached `index.html` keeps a browser pinned to the previous build: the
 * HTML is what points at the content-hashed asset names, so it must revalidate
 * while the assets stay immutable.
 */
describe('static cache policy', () => {
  it('lets hashed assets be cached forever', () => {
    expect(cacheControlFor('/assets/index-BySzx8C3.js')).toContain('immutable')
    expect(cacheControlFor('/assets/ghostty-vt-PH6eNY6t.wasm')).toContain('immutable')
  })

  it('does not hard-cache anything else', () => {
    expect(cacheControlFor('/favicon.ico')).not.toContain('immutable')
    expect(cacheControlFor('/sitemap.txt')).not.toContain('immutable')
  })

  it('serves the HTML shell with a revalidating cache header', async () => {
    const response = await serveIndexHtml()

    expect(response.status).toBe(200)
    const cacheControl = response.headers.get('Cache-Control') ?? ''
    expect(cacheControl).toContain('no-cache')
    expect(cacheControl).not.toContain('immutable')
    expect(response.headers.get('Content-Type')).toContain('text/html')
    expect(await response.text()).toContain('<div id="root">')
  })

  it('keeps HTML out of the prebuilt route map so it is read per request', async () => {
    const routes = await buildStaticRoutes()

    expect(Object.keys(routes)).not.toContain('/index.html')
    // The hashed bundle is still served from the in-memory map.
    expect(Object.keys(routes).some((key) => key.startsWith('/assets/'))).toBe(true)
  })
})
