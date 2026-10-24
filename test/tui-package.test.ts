import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import manifest from '../package.json' with { type: 'json' }

/**
 * The SDK we build against, read from the INSTALL rather than written down.
 *
 * Its own peer floors are the thing ours must not fall below, and a hand-kept copy of
 * them is exactly the kind of value that looks right and is not - it drifts the moment
 * either side moves, and nothing notices until a host satisfies the SDK and fails us.
 *
 * Read through the filesystem rather than imported, because `@opencode/plugin` does not
 * export its `package.json` - an `import ... with { type: 'json' }` against it is a
 * TS2307, since the exports map has no entry for the file.
 */
function readSdkPeers(): Record<string, string> {
  const file = resolve(import.meta.dir, '../node_modules/@opencode/plugin/package.json')
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null)
    throw new Error('the SDK manifest is not an object')
  const peers = (parsed as { peerDependencies?: unknown }).peerDependencies
  if (typeof peers !== 'object' || peers === null)
    throw new Error('the SDK declares no peer dependencies')
  return peers as Record<string, string>
}

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
  // The floors are the SDK's own peer dependencies, read from the INSTALLED
  // @opencode/plugin rather than written down here.
  //
  // Written down, they were a copy that could drift: a comment said they were
  // "the SDK's own, copied rather than chosen", and the two did drift the moment
  // either side moved. Importing the installed manifest makes the assertion a
  // statement about the relationship - we ask for at least what the host does -
  // instead of about a pair of strings that have to be kept in step by hand.
  //
  // `as const` so the names stay literal types: the imported JSON is typed by its
  // own keys, so indexing it with a widened `string` would be an implicit any.
  const names = ['@opencode/theme', '@opentui/core', '@opentui/solid', 'solid-js'] as const

  const sdkPeers = readSdkPeers()

  // Takes `string | undefined` on purpose. Under `noUncheckedIndexedAccess` an index
  // into a record is `string | undefined`, and a package that stopped declaring one of
  // these is exactly the situation worth failing on - with a message naming it, rather
  // than a TypeError from inside the parser.
  //
  // Compared as a TUPLE, not with `Number()`: `Number('2.0.29')` is NaN, because a
  // version is not a decimal. A numeric compare on the string parses every version
  // snippet after the first dot as NaN, which makes `>=` false for every pair and turns
  // the case into "always fails", first measured exactly like that.
  const parseFloor = (
    range: string | undefined,
    who: string
  ): readonly [number, number, number] => {
    const digits = range?.replace(/^>=/, '').match(/\d+\.\d+\.\d+/)?.[0]
    if (digits === undefined) {
      throw new Error(`${who} declares no comparable version floor: ${String(range)}`)
    }
    const [major, minor, patch] = digits.split('.').map((part) => Number(part))
    if (major === undefined || minor === undefined || patch === undefined) {
      throw new Error(`${who} has no three-part version: ${digits}`)
    }
    return [major, minor, patch] as const
  }

  /**
   * Component-wise `>=` on the parsed tuples.
   *
   * Kept as a named function rather than an inline array comparison so the meaning is
   * in one place, and as the only place: comparing `[2, 0, 29]` to `[2, 0, 29]` with an
   * array `===` compares object identity, not contents, which is the other way to get
   * this wrong and both ways end up "always false".
   */
  const ge = (
    ours: readonly [number, number, number],
    atLeast: readonly [number, number, number]
  ): boolean => {
    for (const index of [0, 1, 2]) {
      const a = ours[index]
      const b = atLeast[index]
      if (a === b) continue
      return (a ?? 0) > (b ?? 0)
    }
    return true
  }

  it('asks for at least the floor the SDK asks for', () => {
    // The invariant, and the only part of it that is a real requirement: a host
    // that satisfies @opencode/plugin must satisfy us too. Ours may be HIGHER -
    // we pin opentui to the newest release and rely on a fix only 0.6.x has - but
    // never lower, or a host could satisfy the SDK and fail us.
    for (const name of names) {
      const ours = manifest.peerDependencies[name]
      expect(ours).toBeDefined()
      const ok =
        parseFloor(ours, `our peerDependencies.${name}`) >=
        parseFloor(sdkPeers[name], `the SDK's peerDependencies.${name}`)
      expect({ name, ok }).toEqual({ name, ok: true })
    }
  })

  it('names the opentui it builds and type-checks against', () => {
    // Not a drift guard: a statement of the decision. The panel needs a scrollbox
    // with multi-line text, which renders nothing before 0.6.x - measured against
    // both, 0.5.14 shows the OLDEST lines and 0.6.6 the newest. The floor tracks the
    // devDependency, so the contract the typecheck proves is the one consumers get;
    // it is raised by the same commit that raises the pin, never ahead of it.
    expect(manifest.peerDependencies['@opentui/solid']).toBe('>=0.6.8')
    expect(manifest.peerDependencies['@opentui/core']).toBe('>=0.6.8')
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
    // against something older than it promises to need. Asserted as a range rather
    // than as two exact strings, so taking a newer opentui is a normal bump and not a
    // test edit - the previous form made every upgrade look like a regression.
    const dev = manifest.devDependencies
    for (const name of ['@opentui/core', '@opentui/solid'] as const) {
      const pinned = dev[name]
      expect(pinned).toBeDefined()
      const ok = ge(
        parseFloor(pinned, `our devDependencies.${name}`),
        parseFloor(manifest.peerDependencies[name], `our peerDependencies.${name}`)
      )
      expect({ name, ok }).toEqual({ name, ok: true })
    }
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
    expect(manifest.overrides?.seroval).toBe('1.6.8')
  })

  // The same shape once more, and the one that arrived last: `ip-address@10.7.3` carries a
  // moderate advisory (Address6 matches a zone identifier in quadratic time), and it reached
  // the lockfile twice - through `express-rate-limit` (in the MCP SDK's express stack) and
  // through `socks`. Nothing in this repository parses an IP literal that way; the MCP route
  // is stdio-only, so neither express nor the SOCKS agent is instantiated.
  //
  // Inside the contract as well: both carriers declare `ip-address` as `^10.x`, so 10.7.4 is
  // a version their own manifests accept, and the patch is the fix for this advisory.
  it('overrides ip-address past the detail advisory its carriers pin into it', () => {
    // Expiry: when `express-rate-limit` (or `socks`) moves to a range that already admits a
    // patched version, the override has outlived its reason and goes.
    expect(manifest.overrides?.['ip-address']).toBe('10.7.4')
  })

  // The four the `bun audit` gate found when it was finally run to the end: one
  // through the MCP SDK's express, three through the effect stacks of
  // `@opencode/plugin`, `@opencode/client` and `@opencode/theme`.
  //
  // `body-parser` and the 8.x `undici` are inside what their carriers declare
  // (express: `^2.3.0`, @effect/platform-node: `^8.11.2`), and the 6.x `undici` is a
  // different major, so it gets its own `pkg@range` key instead of being dragged
  // across one. `zod` is the exception: `@opencode-ai/plugin` pins 4.1.8 exactly, so
  // 4.6.7 is outside that range - the same major, and the whole suite exercises the
  // tool schemas that would notice a break.
  it('overrides the advisories the audit gate surfaced, inside the carriers where it can', () => {
    expect(manifest.overrides?.['body-parser']).toBe('2.4.0')
    expect(manifest.overrides?.['undici@^8.0.0']).toBe('8.12.3')
    expect(manifest.overrides?.['undici@^6.0.0']).toBe('6.29.1')
    expect(manifest.overrides?.zod).toBe('4.6.7')
    // `toml` is the one that leaves a declared range: every carrier asks for
    // `^4.1.1` and the fix is 5.0.1. It was tried rather than excused - the suite
    // exercises the tool schemas and the whole plugin boots with it - and the
    // expiry is the day a carrier asks for `^5`, at which point this line goes.
    expect(manifest.overrides?.toml).toBe('5.0.1')
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
      // is a dependency no consumer resolves. `patches` is NOT shipped: the ghostty-web
      // patch only touches client code that is already prebundled in `dist/web`, and npm
      // strips `patchedDependencies` patch files out of the tarball anyway - shipping the
      // directory would only add dead weight.
      publishedFiles: manifest.files,
    }).toEqual({ solidJsShipped: false, publishedFiles: ['dist'] })
  })
})
