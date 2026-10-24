import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A throwaway `node_modules` tree for the licence tests.
 *
 * The tree has to be built at test time rather than committed: a fixture
 * directory literally named `node_modules` is ignored by `.gitignore` everywhere,
 * so a checked-in one would exist on the machine that made it and nowhere else.
 * The licence *files* are committed; only the installation around them is built.
 */

const tempRoots: string[] = []

export function cleanupLicenceTrees(): void {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentterm-licenses-'))
  tempRoots.push(root)
  return root
}

export interface FixturePackage {
  name: string
  version: string
  /** A file under `test/fixtures/licenses/`, copied in as the licence file. */
  license?: string
  /** The name it is copied to; `LICENSE` when omitted. */
  licenseName?: string
  /** The directory under `node_modules`; the package name when omitted. */
  dir?: string
  /** The manifest `author`, in either shape npm allows. */
  author?: string | { name: string }
  /** A `LICENSE` symlink to nothing, so reading it fails. */
  unreadable?: boolean
  /** Extra `NOTICE` content, for the "which file wins" case. */
  notice?: string
}

/** Build a `node_modules` directory holding these packages and return its path. */
export function makeTree(packages: FixturePackage[]): string {
  const modules = join(tempRoot(), 'node_modules')
  for (const pkg of packages) {
    const dir = join(modules, pkg.dir ?? pkg.name)
    mkdirSync(dir, { recursive: true })
    const manifest = { name: pkg.name, version: pkg.version, author: pkg.author }
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    if (pkg.unreadable) {
      symlinkSync(join(dir, 'missing-license-target'), join(dir, 'LICENSE'))
      continue
    }
    if (pkg.license !== undefined) {
      copyFileSync(join(import.meta.dir, pkg.license), join(dir, pkg.licenseName ?? 'LICENSE'))
    }
    if (pkg.notice !== undefined) writeFileSync(join(dir, 'NOTICE'), pkg.notice)
  }
  return modules
}

/** A temporary directory that is removed with the others. */
export function licenceScratchDir(): string {
  return tempRoot()
}

export function readLicenseFixture(name: string): string {
  return readFileSync(join(import.meta.dir, name), 'utf8')
}

interface RawEntry {
  license: string
  name: string
  versions?: string[]
}

/** Bun's report shape, with the absolute `paths` that must not survive it. */
export function rawReport(entries: RawEntry[]): Record<string, unknown[]> {
  const report: Record<string, unknown[]> = {}
  for (const entry of entries) {
    const bucket = report[entry.license] ?? []
    bucket.push({
      name: entry.name,
      versions: entry.versions ?? ['1.0.0'],
      paths: [`/home/someone/node_modules/${entry.name}`],
      author: 'Not copied',
    })
    report[entry.license] = bucket
  }
  return report
}
