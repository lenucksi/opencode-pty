import { describe, expect, it } from 'bun:test'
import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'

import { serveStaticFallback } from '../src/web/server/handlers/static.ts'

/**
 * The paths no route claims.
 *
 * The route map is built once, at start, and holds what `dist/web` had then; the shell
 * is read per request, and that is what points at the content-hashed assets. A rebuild
 * under a running server therefore asks the browser for filenames the map has never
 * seen - and the answer to that must never be the shell, because the browser asked for
 * a module and would get HTML: a white page and a MIME-type error, with nothing on
 * screen to say why.
 */

const ASSETS = resolve(import.meta.dir, '../dist/web/assets')

/** A real file the build produced, so the case is about the handler and not a fake. */
function aBuiltAsset(): string {
  const name = readdirSync(ASSETS).find((file) => file.endsWith('.js'))
  if (name === undefined) throw new Error('the test needs a built asset under dist/web/assets')
  return name
}

const get = (path: string): Request => new Request(`http://127.0.0.1:4200${path}`)

describe('an asset a rebuild added', () => {
  it('is served from disk, with the cache header the hashed name earns', async () => {
    const response = await serveStaticFallback(get(`/assets/${aBuiltAsset()}`))

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toContain('javascript')
    expect(response.headers.get('Cache-Control')).toContain('immutable')
    expect((await response.text()).length).toBeGreaterThan(0)
  })

  it('answers 404 rather than the shell when it is not there', async () => {
    const response = await serveStaticFallback(get('/assets/index-THIS-BUILD-NEVER-HAD.js'))

    expect(response.status).toBe(404)
    // The shell would be the white page: a module that is not there must say so.
    expect(response.headers.get('Content-Type') ?? '').not.toContain('text/html')
  })

  it('refuses to leave the asset directory', async () => {
    // Percent-encoded, because the URL parser collapses a literal `..` before the
    // handler ever sees the path - which is exactly why the check decodes first.
    const escapes = ['/assets/%2e%2e/%2e%2e/package.json', '/assets/../../package.json']

    for (const path of escapes) {
      const response = await serveStaticFallback(get(path))
      // Either refused as an escape or normalised away by the parser: neither is
      // the package manifest.
      expect([302, 404]).toContain(response.status)
      const body = await response.text()
      expect(body).not.toContain('@lenucksi/agentterm')
    }
  })
})

describe('a path the app does not have', () => {
  it('lands on the app, under its own address', async () => {
    const response = await serveStaticFallback(get('/sessions/that/no/longer/exists'))

    expect(response.status).toBe(302)
    // Not `/index.html`: the address a reader ends up looking at should be the one
    // they can type.
    expect(response.headers.get('Location')).toBe('/')
  })
})
