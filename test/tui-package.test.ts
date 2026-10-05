import { describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import manifest from '../package.json' with { type: 'json' }

/**
 * The manifest contract for the TUI entrypoint.
 *
 * opencode decides a plugin has a TUI half by resolving `<plugin>/tui` and finding
 * a module. That resolution goes through the `exports` map, and the wildcard
 * patterns below do NOT cover it: `./*` matches one path segment, so
 * `opencode-pty/tui` resolves to `dist/src/tui.js` — a file that does not exist —
 * rather than to the directory's `index.js`. Without an explicit entry the TUI
 * silently reports the plugin as having no TUI feature, which reads as "the panel
 * I configured never appears" rather than as a packaging mistake.
 */

const entry = manifest.exports['./tui']

describe('the TUI entrypoint', () => {
  it('is declared explicitly, because the wildcard patterns do not reach it', () => {
    expect(entry).toBeDefined()
    expect(entry).toEqual({
      types: './dist/src/tui/index.d.ts',
      default: './dist/src/tui/index.js',
    })
  })

  it('points at files the build produces from a source file that exists', () => {
    if (!entry) throw new Error('no ./tui export')
    // The source the built entry comes from. Checked because a manifest entry can
    // outlive the file it names, and the build would then succeed while producing
    // nothing at that path.
    expect(existsSync(resolve(import.meta.dir, '../src/tui/index.ts'))).toBe(true)
    expect(existsSync(resolve(import.meta.dir, '../src/tui/lib.ts'))).toBe(true)
  })
})

describe('the TUI entrypoint behind the V2 subpath', () => {
  // The documented V2 config entry is the package name with a subpath, and the host
  // builds the TUI specifier from that name: a configured `opencode-pty/v2` is
  // probed as `opencode-pty/v2/tui`. Without this entry the server half loads and
  // the panel silently never appears - measured with the host's own resolver.
  const viaV2 = manifest.exports['./v2/tui']

  it('is declared, because the host probes <configured-name>/tui', () => {
    expect(viaV2).toEqual({
      types: './dist/src/tui/index.d.ts',
      default: './dist/src/tui/index.js',
    })
  })

  it('names the same module as the bare entry, so both spellings agree', () => {
    if (!viaV2 || !entry) throw new Error('a TUI export is missing')
    expect(viaV2.default).toBe(entry.default)
  })
})

describe('the TUI dependencies', () => {
  // The floors are the SDK's own peer dependencies, copied rather than chosen:
  // a host that satisfies @opencode/plugin satisfies us. Getting them from the
  // package that declares them is the only way they cannot drift apart.
  // `as const` so the names stay literal types: the imported JSON is typed by its
  // own keys, so indexing it with a widened `string` would be an implicit any.
  const names = ['@opencode/theme', '@opentui/core', '@opentui/solid', 'solid-js'] as const

  const expected: Record<(typeof names)[number], string> = {
    '@opencode/theme': '>=2.0.23',
    '@opentui/core': '>=0.5.14',
    '@opentui/solid': '>=0.5.14',
    'solid-js': '>=1.9.0',
  }

  it('declares the same floors the SDK declares', () => {
    for (const name of names) {
      expect(manifest.peerDependencies[name]).toBe(expected[name])
    }
  })

  it('marks every one of them optional, so installing without a TUI still works', () => {
    // The V1 and V2 plugin entrypoints must keep working for a host that has no
    // TUI at all. A required peer would make that install fail.
    for (const name of names) {
      expect(manifest.peerDependenciesMeta?.[name]?.optional).toBe(true)
    }
  })

  it('installs them for development, so the TUI contract is actually type-checked', () => {
    // Without these, `tsc` cannot see @opencode/plugin/tui's types at all and the
    // panel would be checked against nothing.
    expect(manifest.devDependencies['@opencode/theme']).toBeDefined()
    expect(manifest.devDependencies['@opentui/core']).toBeDefined()
    expect(manifest.devDependencies['@opentui/solid']).toBeDefined()
    expect(manifest.devDependencies['solid-js']).toBeDefined()
  })

  it('pins the development versions to the floors it claims', () => {
    // A floor the dev install does not satisfy would mean the panel is compiled
    // against something older than it promises to need.
    const dev = manifest.devDependencies
    expect(dev['@opentui/solid']).toBe('0.5.14')
    expect(dev['@opentui/core']).toBe('0.5.14')
  })

  it('overrides @babel/core past the advisory that @opentui/solid pins into it', () => {
    // @opentui/solid ships a Babel plugin and pins @babel/core exactly, so the
    // 7.28.0 it asks for carries GHSA-4 (arbitrary file read via a
    // sourceMappingURL comment), and `bun audit` fails the gate on it. The plugin
    // builds JSX; we call `@opentui/solid/jsx-runtime` instead, so Babel is never
    // executed here - but it is still installed, and still audited. Upstream can
    // fix the pin; until then this does, and it cannot affect the panel because
    // nothing in it runs Babel.
    //
    // Remove this together with a @opentui/solid release that pins a patched
    // version, or the override outlives its reason.
    expect(manifest.overrides?.['@babel/core']).toBe('7.29.7')
  })
})
