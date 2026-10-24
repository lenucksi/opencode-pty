import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { LicenseGroup, LicensePackage, LicenseReport } from '../src/web/shared/licenses.ts'

/**
 * Generates `dist/licenses.json` from `bun pm licenses --json`.
 *
 * The same reason as `scripts/version.ts`: a generated module in the source tree
 * leaves the working tree dirty after every build and blocks every branch switch.
 * `dist` is the only thing the published package ships, so the notices travel
 * with the artifact without anyone committing them.
 *
 * The artifact is deterministic. Two runs against one lockfile are byte-identical:
 * groups are sorted by licence, packages by name and then version, and nothing
 * volatile (absolute paths, authors, timestamps) is copied out of Bun's report.
 * That is what lets a test assert it, and a diff show a dependency change rather
 * than a new machine's paths.
 */

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')

export const LICENSES_PATH = join(repoRoot, 'dist', 'licenses.json')

/** Locale-independent ordering, so the bytes do not depend on the host's ICU. */
function compareText(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * One entry of Bun's report.
 *
 * Bun gives every package a `versions` array (a package can be installed at two
 * versions at once) and a pile of metadata this tab has no use for. Only the
 * three fields a reader needs survive; in particular the absolute `paths` field
 * is dropped, because it names the machine that built the artifact.
 */
function toPackages(entry: unknown, license: string): LicensePackage[] {
  if (!isRecord(entry) || typeof entry.name !== 'string' || entry.name === '') return []
  const versions = Array.isArray(entry.versions)
    ? entry.versions.filter((version): version is string => typeof version === 'string')
    : []
  const effective = versions.length > 0 ? versions : ['unknown']
  return effective
    .filter((version) => version !== '')
    .map((version) => ({ name: entry.name as string, version, license }))
}

/**
 * Normalise Bun's `{ "<licence>": [entry, ...] }` report.
 *
 * Unknown shapes are skipped rather than thrown on: a future Bun that adds a
 * field must not break the build, and an empty report is still a valid answer.
 */
export function buildLicenseReport(raw: unknown): LicenseReport {
  const groups = new Map<string, LicensePackage[]>()
  if (isRecord(raw)) {
    for (const [license, entries] of Object.entries(raw)) {
      if (!Array.isArray(entries)) continue
      const packages = groups.get(license) ?? []
      for (const entry of entries) {
        packages.push(...toPackages(entry, license))
      }
      groups.set(license, packages)
    }
  }

  const normalised: LicenseGroup[] = []
  for (const [license, packages] of groups) {
    // Deduplicate on name@version: the same package can be reported twice when
    // an entry is malformed, and a duplicated row reads as two installs.
    const seen = new Set<string>()
    const unique = packages.filter((pkg) => {
      const key = `${pkg.name}@${pkg.version}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    unique.sort((a, b) => compareText(a.name, b.name) || compareText(a.version, b.version))
    normalised.push({ license, count: unique.length, packages: unique })
  }
  normalised.sort((a, b) => compareText(a.license, b.license))

  return {
    total: normalised.reduce((sum, group) => sum + group.count, 0),
    groups: normalised,
  }
}

/** Render the artifact. Pure, so determinism can be asserted without the disk. */
export function renderLicenseReport(report: LicenseReport): string {
  return `${JSON.stringify(report, null, 2)}\n`
}

export function writeLicenseReport(report: LicenseReport, target: string = LICENSES_PATH): void {
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, renderLicenseReport(report))
}

/** Run Bun's own report and return its parsed JSON. */
export function readLicenseJson(cwd: string = repoRoot): unknown {
  // `spawnSync` rather than a shell: no quoting question, and the timeout covers
  // a `bun pm` that blocks on an install lock instead of hanging the build.
  const result = spawnSync('bun', ['pm', 'licenses', '--json'], {
    cwd,
    encoding: 'utf8',
    timeout: 60_000,
  })
  if (result.status !== 0) {
    throw new Error(`bun pm licenses exited ${result.status ?? 'without a status'}`)
  }
  return JSON.parse(result.stdout)
}

if (import.meta.main) {
  const report = buildLicenseReport(readLicenseJson())
  writeLicenseReport(report)
  // One line: a build log that does not say what it generated cannot be checked.
  console.log(`[licenses] ${report.total} packages under ${report.groups.length} licences`)
}
