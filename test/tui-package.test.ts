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

  // Same shape as the override above, reached the same way: a transitive dependency
  // carries an advisory, the code that carries it is unreachable from a terminal plugin,
  // and the choice is between an override and narrowing the check that found it.
  //
  // `seroval@1.5.6` has a critical advisory (GHSA-mv8w…, thenable assimilation) plus a high
  // one, and it reached the lockfile through `solid-js@1.9.15`, which pins `~1.5.4` for both
  // `seroval` and `seroval-plugins`. Only `solid-js/web/dist/server.js` imports it - Solid's
  // SSR build, and nothing in a terminal plugin renders HTML. `bun audit` failed on it and
  // so did Aislop's own `security/vulnerable-dependency` rule.
  //
  // Narrowing the audit to `--production` would have quieted `bun audit` and done nothing
  // about Aislop, which has no such scope - one suppression and one silenced rule, for an
  // advisory still installed. The override fixes both, and it is inside the contract rather
  // than past it: `seroval-plugins` declares `seroval` as a PEER of `^1.0`, so 1.6.8 is a
  // version its own package asks a consumer for.
  it('overrides seroval past the advisory solid-js pins into it', () => {
    // Expiry, like the override above: solid-js is at 1.9.15 with no release carrying a
    // patched seroval, and `~1.5.4` will not reach 1.6.x on its own. When solid-js moves to
    // a version that asks for a fixed seroval, this goes with it.
    expect(manifest.overrides?.['seroval']).toBe('1.6.8')
  })

  // The premise the override is comfortable in: the vulnerable code is a build-time and
  // SSR-only path, and `solid-js` is not something a consumer installs. Were it promoted to
  // `dependencies`, a terminal plugin would be shipping Solid's server renderer - code that
  // then really is reachable in a browser SSR context someone might build on top of it.
  //
  // Note this is no longer what keeps the audit quiet - the override does that. It is the
  // second line, and the one that says why the first is safe.
  it('keeps solid-js out of the dependencies a consumer installs', () => {
    const shipped = Object.keys(manifest.dependencies ?? {})
    expect({
      solidJsShipped: shipped.includes('solid-js'),
      // The whole package: a published artifact is `files`, so a dependency missing here
      // is a dependency no consumer resolves.
      publishedFiles: manifest.files,
    }).toEqual({ solidJsShipped: false, publishedFiles: ['dist', 'patches'] })
  })
})
