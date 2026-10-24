import { type Dirent, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'

import type { CopyrightSource } from '../src/web/shared/licenses.ts'

/**
 * Reading the notices out of an installed `node_modules` tree.
 *
 * Separate from `scripts/licenses.ts` because the two jobs are different: this
 * module looks at the disk, that one assembles and renders the report. Nothing
 * here throws for a package that cannot be read - a missing or unreadable file
 * becomes `none`, because a notice that fails the build gets replaced by no
 * notice at all.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function listDirectory(path: string): Dirent[] {
  try {
    return readdirSync(path, { withFileTypes: true })
  } catch {
    return []
  }
}

/** The real path of a directory, or `null` when it is missing or unreadable. */
function realDirectory(path: string): string | null {
  try {
    return statSync(path).isDirectory() ? realpathSync(path) : null
  } catch {
    return null
  }
}

/** Whether `child` sits under `parent`. Both are already resolved. */
function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`)
}

// --------------------------------------------------------------------------
// The installed tree
// --------------------------------------------------------------------------

export interface Manifest {
  name: string
  version: string
  author: string | null
}

export interface InstalledPackage {
  /** The real directory the package was found in. */
  dir: string
  /** Its path relative to the modules root, for a deterministic tie-break. */
  path: string
}

export type PackageIndex = Map<string, InstalledPackage>

function readAuthor(value: unknown): string | null {
  if (typeof value === 'string') {
    const name = value.trim()
    return name === '' ? null : name
  }
  if (isRecord(value) && typeof value.name === 'string' && value.name.trim() !== '') {
    return value.name.trim()
  }
  return null
}

function readManifest(dir: string): Manifest | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    if (!isRecord(parsed)) return null
    const { name, version } = parsed
    if (typeof name !== 'string' || name === '') return null
    if (typeof version !== 'string' || version === '') return null
    return { name, version, author: readAuthor(parsed.author) }
  } catch {
    return null
  }
}

/** The package names one entry of a `node_modules` directory stands for. */
function packageNames(entry: Dirent, modulesDir: string): string[] {
  if (entry.name.startsWith('.')) return []
  if (!entry.isDirectory() && !entry.isSymbolicLink()) return []
  if (!entry.name.startsWith('@')) return [entry.name]
  return listDirectory(join(modulesDir, entry.name))
    .filter(
      (child) => (child.isDirectory() || child.isSymbolicLink()) && !child.name.startsWith('.')
    )
    .map((child) => `${entry.name}/${child.name}`)
}

/**
 * Shallower wins, then the lexicographically smaller path.
 *
 * The same name@version can be installed twice (a hoisted copy and a nested one).
 * Picking by walk order would make the artifact depend on the filesystem's
 * `readdir` order, and the two copies need not carry the same licence file.
 */
function isPreferred(candidate: InstalledPackage, existing: InstalledPackage): boolean {
  const candidateDepth = candidate.path.split('/').length
  const existingDepth = existing.path.split('/').length
  if (candidateDepth !== existingDepth) return candidateDepth < existingDepth
  return candidate.path < existing.path
}

/**
 * Add one `node_modules/<name>` to the index and return its real directory.
 *
 * A directory that resolves outside the tree (a workspace symlink into a
 * checkout, say) is not this project's installed dependency and is not read.
 */
function collectPackage(
  index: PackageIndex,
  rootReal: string,
  modulesDir: string,
  name: string,
  prefix: string
): string | null {
  const dir = realDirectory(join(modulesDir, name))
  if (dir === null || !isInside(dir, rootReal)) return null
  const manifest = readManifest(dir)
  if (manifest === null) return dir
  const candidate: InstalledPackage = { dir, path: `${prefix}${name}` }
  record(index, `${manifest.name}@${manifest.version}`, candidate)
  // Also by name alone: Bun reports a git or tarball dependency by its specifier
  // (`github:anomalyco/ghostty-web#6e24d04`), while the installed manifest says
  // `0.3.0`, so the exact key would miss a package that is right there on disk.
  record(index, manifest.name, candidate)
  return dir
}

function record(index: PackageIndex, key: string, candidate: InstalledPackage): void {
  const current = index.get(key)
  if (current === undefined || isPreferred(candidate, current)) index.set(key, candidate)
}

/** The install of one package, by `name@version`, falling back to the name. */
export function findInstalledPackage(
  index: PackageIndex,
  name: string,
  version: string
): InstalledPackage | undefined {
  return index.get(`${name}@${version}`) ?? index.get(name)
}

/**
 * Index every installed package by `name@version`.
 *
 * Walked rather than read from Bun's `paths`: those name the machine that built
 * the artifact, and a nested copy (`node_modules/node-gyp/node_modules/undici`) is
 * a different install that must not inherit the hoisted copy's licence file.
 */
export function indexInstalledPackages(root: string): PackageIndex {
  const index: PackageIndex = new Map()
  const rootReal = realDirectory(root)
  if (rootReal === null) return index
  const visited = new Set<string>()
  const walk = (modulesDir: string, prefix: string): void => {
    const real = realDirectory(modulesDir)
    if (real === null || visited.has(real)) return
    visited.add(real)
    for (const entry of listDirectory(modulesDir)) {
      for (const name of packageNames(entry, modulesDir)) {
        const dir = collectPackage(index, rootReal, modulesDir, name, prefix)
        if (dir !== null) walk(join(dir, 'node_modules'), `${prefix}${name}/node_modules/`)
      }
    }
  }
  walk(root, '')
  return index
}

// --------------------------------------------------------------------------
// The copyright line
// --------------------------------------------------------------------------

/** What a licence file goes by, in the order a reader would check it. */
const LICENSE_FILE_NAMES = [
  'license',
  'license.md',
  'licence',
  'license.txt',
  'copying',
  'notice',
  // The split-licence convention (`postcss-selector-parser`, `@biomejs/biome`):
  // the MIT text is in `LICENSE-MIT`, and a package with no plain `LICENSE` would
  // otherwise be reported as carrying no notice at all.
  'license-mit',
  'license-apache',
]

type LicenseFileRead =
  { state: 'found'; text: string } | { state: 'missing' } | { state: 'unreadable' }

function readLicenseFile(dir: string): LicenseFileRead {
  // Matched case-insensitively: `License`, `LICENSE.txt` and `Licence` all ship.
  const byLowerName = new Map<string, string>()
  for (const entry of listDirectory(dir)) {
    if (entry.isFile() || entry.isSymbolicLink()) {
      byLowerName.set(entry.name.toLowerCase(), entry.name)
    }
  }
  for (const candidate of LICENSE_FILE_NAMES) {
    const name = byLowerName.get(candidate)
    if (name === undefined) continue
    try {
      return { state: 'found', text: readFileSync(join(dir, name), 'utf8') }
    } catch {
      return { state: 'unreadable' }
    }
  }
  return { state: 'missing' }
}

/**
 * A line that opens a copyright notice.
 *
 * Case-sensitive on purpose. A *wrapped sentence* in a licence body starts with a
 * lowercase `copyright` - `copyright in it.` in the BlueOak text, `copyright
 * notice and this permission notice …` in `glob`'s - and those were the only lines
 * a looser match picked up wrongly in the installed tree. An all-caps notice is
 * still recognised when a year follows it, which is the one shape it takes.
 */
const COPYRIGHT_LINE =
  /^(?:Copyright\b(?!\s+(?:holders?|owners?|notices?|law|and\b|licen[cs]e))|COPYRIGHT\s+(?:\([cC]\)|©|\d|\[|<))/u

/** A notice carrying a year and nothing else yet, such as `Copyright (c) 2011-2019`. */
const YEAR_ONLY = /^copyright\s*(?:\(c\)|©)?[\d\s,.\-–—[\]]*$/i

/**
 * Whether the notice is still missing its owner.
 *
 * A wrapped notice is the reason this exists: the first line can be the year
 * alone, and the owner on the next one. A notice that already names someone is
 * finished, though, which is what keeps the `GNU GENERAL PUBLIC LICENSE` header
 * from swallowing the sentence beneath it.
 */
function looksIncomplete(notice: string): boolean {
  const line = notice.replace(/\s+/gu, ' ').trim()
  if (YEAR_ONLY.test(line)) return true
  if (/(?:[,&(<-]|\b(?:and|or|the|of|by|for|with))$/iu.test(line)) return true
  return /\([^)]*$/u.test(line)
}

/**
 * Every copyright notice in one licence file, each folded onto a single line.
 *
 * Folding stops as soon as the notice names an owner, so `Copyright (c) 2011-2019`
 * takes the next line with it while `Copyright (c) 2020 Acme Inc.` does not take
 * the sentence that follows. Text is otherwise verbatim, and an exact duplicate is
 * kept once: a file that repeats its own header says nothing twice.
 */
export function extractCopyrightLines(text: string): string[] {
  const found: string[] = []
  let notice: string[] | null = null
  const flush = (): void => {
    if (notice === null) return
    const line = notice.join(' ').replace(/\s+/gu, ' ').trim()
    if (line !== '' && !found.includes(line)) found.push(line)
    notice = null
  }
  for (const raw of text.split(/\r\n|\r|\n/)) {
    if (raw.trim() === '') {
      flush()
      continue
    }
    if (COPYRIGHT_LINE.test(raw.trimStart())) {
      flush()
      notice = [raw]
      continue
    }
    if (notice === null) continue
    if (looksIncomplete(notice.join(' '))) {
      notice.push(raw)
      continue
    }
    flush()
  }
  flush()
  return found
}

/**
 * The text a licence body is grouped by.
 *
 * Line endings unified, trailing whitespace per line stripped, leading and
 * trailing blank lines removed - no more, because the body is reproduced as the
 * package wrote it. Two wordings stay two bodies; that is the point.
 */
export function normaliseLicenseText(text: string): string {
  const lines = text
    .replace(/^\uFEFF/u, '')
    .split(/\r\n|\r|\n/)
    .map((line) => line.replace(/[ \t]+$/u, ''))
  let first = 0
  let last = lines.length
  while (first < last && (lines[first] ?? '').trim() === '') first += 1
  while (last > first && (lines[last - 1] ?? '').trim() === '') last -= 1
  return lines.slice(first, last).join('\n')
}

export interface Reading {
  copyright: string[]
  copyrightSource: CopyrightSource
  /** The licence body, normalised, or `null` when the package ships no file. */
  body: string | null
}

const NO_READING: Reading = { copyright: [], copyrightSource: 'none', body: null }

/** The copyright lines a package's own licence file spells, else its author. */
export function readPackageNotice(installed: InstalledPackage | undefined): Reading {
  if (installed === undefined) return NO_READING
  const file = readLicenseFile(installed.dir)
  if (file.state === 'found') {
    return {
      copyright: extractCopyrightLines(file.text),
      copyrightSource: 'license-file',
      body: normaliseLicenseText(file.text),
    }
  }
  if (file.state === 'unreadable') return NO_READING
  const author = readManifest(installed.dir)?.author ?? null
  if (author === null) return NO_READING
  return { copyright: [author], copyrightSource: 'author-field', body: null }
}
