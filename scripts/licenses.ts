import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type {
  LicenseGroup,
  LicensePackage,
  LicenseReport,
  LicenseText,
} from '../src/web/shared/licenses.ts'
import {
  indexInstalledPackages,
  type PackageIndex,
  readPackageNotice,
  findInstalledPackage,
} from './license-files.ts'

/**
 * Generates `dist/licenses.json` and `dist/THIRD-PARTY-NOTICES.md`.
 *
 * The same reason as `scripts/version.ts`: a generated module in the source tree
 * leaves the working tree dirty after every build and blocks every branch switch.
 * `dist` is the only thing the published package ships, so the notices travel
 * with the artifact without anyone committing them.
 *
 * An MIT or BSD licence requires the copyright notice to travel with every copy,
 * so naming the licence is not enough: the owner and the year have to be
 * reproduced, and each licence body has to be reproduced once rather than linked
 * to. `scripts/license-files.ts` reads both out of each installed package's own
 * licence file - never out of the licence id, which carries neither.
 *
 * The artifact is deterministic. Two runs against one lockfile are byte-identical:
 * groups are sorted by licence, packages by name and then version, bodies by
 * package count and then licence and then text, and nothing volatile (absolute
 * paths, timestamps) is copied out of Bun's report.
 */

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')

/** Where the build puts the machine-readable artifact. */
export const LICENSES_PATH = join(repoRoot, 'dist', 'licenses.json')

/** Where the build puts the flat, greppable notice. */
export const NOTICES_PATH = join(repoRoot, 'dist', 'THIRD-PARTY-NOTICES.md')

/** Locale-independent ordering, so the bytes do not depend on the host's ICU. */
function compareText(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

interface PackageRow extends LicensePackage {
  body: string | null
}

/** One licence body and the packages that ship it. */
export interface LicenseBody {
  license: string
  text: string
  packages: LicensePackage[]
}

export interface LicenseNotices {
  report: LicenseReport
  bodies: LicenseBody[]
}

export interface LicenseOptions {
  /** The installed tree to read licence files from. Defaults to this repo's. */
  nodeModulesRoot?: string
}

/**
 * One entry of Bun's report.
 *
 * Bun gives every package a `versions` array (a package can be installed at two
 * versions at once) and a pile of metadata this tab has no use for. Only the
 * fields a reader needs survive; in particular the absolute `paths` field is
 * dropped, because it names the machine that built the artifact.
 */
function toPackages(entry: unknown, license: string, index: PackageIndex): PackageRow[] {
  if (!isRecord(entry) || typeof entry.name !== 'string' || entry.name === '') return []
  const name = entry.name
  const versions = Array.isArray(entry.versions)
    ? entry.versions.filter((version): version is string => typeof version === 'string')
    : []
  const effective = versions.length > 0 ? versions : ['unknown']
  return effective
    .filter((version) => version !== '')
    .map((version) => ({
      name,
      version,
      license,
      ...readPackageNotice(findInstalledPackage(index, name, version)),
    }))
}

function toLicensePackage(row: PackageRow): LicensePackage {
  return {
    name: row.name,
    version: row.version,
    license: row.license,
    copyright: row.copyright,
    copyrightSource: row.copyrightSource,
  }
}

function byNameThenVersion(a: LicensePackage, b: LicensePackage): number {
  return compareText(a.name, b.name) || compareText(a.version, b.version)
}

function collectRows(raw: unknown, index: PackageIndex): PackageRow[] {
  const rows: PackageRow[] = []
  if (!isRecord(raw)) return rows
  for (const [license, entries] of Object.entries(raw)) {
    if (!Array.isArray(entries)) continue
    for (const entry of entries) rows.push(...toPackages(entry, license, index))
  }
  return rows
}

/**
 * Group rows by licence, one row per installed version.
 *
 * Deduplicated on name@version: the same package can be reported twice when an
 * entry is malformed, and a duplicated row reads as two installs.
 */
function groupRows(rows: PackageRow[]): { groups: LicenseGroup[]; kept: PackageRow[] } {
  const byLicense = new Map<string, PackageRow[]>()
  const seen = new Set<string>()
  const kept: PackageRow[] = []
  for (const row of rows) {
    const key = `${row.license}\u0000${row.name}@${row.version}`
    if (seen.has(key)) continue
    seen.add(key)
    const bucket = byLicense.get(row.license) ?? []
    bucket.push(row)
    byLicense.set(row.license, bucket)
    kept.push(row)
  }
  const groups: LicenseGroup[] = []
  for (const [license, bucket] of byLicense) {
    bucket.sort(byNameThenVersion)
    groups.push({ license, count: bucket.length, packages: bucket.map(toLicensePackage) })
  }
  groups.sort((a, b) => compareText(a.license, b.license))
  return { groups, kept }
}

/** Every distinct licence body, largest group first. */
function buildBodies(rows: PackageRow[]): LicenseBody[] {
  const byText = new Map<string, { licenses: Set<string>; packages: LicensePackage[] }>()
  for (const row of rows) {
    if (row.body === null) continue
    const group = byText.get(row.body) ?? { licenses: new Set<string>(), packages: [] }
    group.licenses.add(row.license)
    group.packages.push(toLicensePackage(row))
    byText.set(row.body, group)
  }
  const bodies: LicenseBody[] = []
  for (const [text, group] of byText) {
    group.packages.sort(byNameThenVersion)
    bodies.push({
      license: [...group.licenses].sort(compareText)[0] ?? 'unknown',
      text,
      packages: group.packages,
    })
  }
  bodies.sort(
    (a, b) =>
      b.packages.length - a.packages.length ||
      compareText(a.license, b.license) ||
      compareText(a.text, b.text)
  )
  return bodies
}

/** The served report plus the bodies the flat notice needs, in one pass. */
export function buildLicenseNotices(raw: unknown, options: LicenseOptions = {}): LicenseNotices {
  const index = indexInstalledPackages(options.nodeModulesRoot ?? join(repoRoot, 'node_modules'))
  const { groups, kept } = groupRows(collectRows(raw, index))
  const bodies = buildBodies(kept)
  const texts: LicenseText[] = bodies.map((body) => ({
    license: body.license,
    packageCount: body.packages.length,
    text: body.text,
  }))
  return {
    report: {
      total: groups.reduce((sum, group) => sum + group.count, 0),
      groups,
      texts,
    },
    bodies,
  }
}

/** The served report alone, for a caller that does not write the flat notice. */
export function buildLicenseReport(raw: unknown, options: LicenseOptions = {}): LicenseReport {
  return buildLicenseNotices(raw, options).report
}

/** Render the artifact. Pure, so determinism can be asserted without the disk. */
export function renderLicenseReport(report: LicenseReport): string {
  return `${JSON.stringify(report, null, 2)}\n`
}

export function writeLicenseReport(report: LicenseReport, target: string = LICENSES_PATH): void {
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, renderLicenseReport(report))
}

/** A fence longer than anything inside the body, so a body cannot end it early. */
function fenceFor(text: string): string {
  const runs = text.match(/`+/gu) ?? []
  const longest = runs.reduce((longestRun, run) => Math.max(longestRun, run.length), 0)
  return '`'.repeat(Math.max(3, longest + 1))
}

function describePackage(pkg: LicensePackage): string {
  const label = `- \`${pkg.name}@${pkg.version}\` — `
  if (pkg.copyright.length > 0) return `${label}${pkg.copyright.join('; ')}`
  return pkg.copyrightSource === 'author-field'
    ? `${label}(manifest author only)`
    : `${label}(no copyright line found)`
}

/**
 * `dist/THIRD-PARTY-NOTICES.md`: the notice a reader greps without a browser.
 *
 * The body comes first and the packages that ship it follow, so a licence text is
 * reproduced exactly once per distinct wording even when hundreds of packages
 * carry it. Packages with no licence file are listed at the end rather than
 * dropped: a notice that quietly omits them is worse than one that says so.
 */
export function renderNoticeMarkdown(notices: LicenseNotices): string {
  const { report, bodies } = notices
  const lines: string[] = [
    '# Third-party notices',
    '',
    'Generated at build time from the lockfile and `node_modules`; do not edit by hand.',
    'The same data is served by `GET /api/licenses` (`dist/licenses.json`) for the Licences',
    'tab of the in-app docs dialog.',
    '',
    `${report.total} packages under ${report.groups.length} licences; ${report.texts.length} distinct licence bodies.`,
    '',
  ]

  const bodiesByLicense = new Map<string, LicenseBody[]>()
  for (const body of bodies) {
    const bucket = bodiesByLicense.get(body.license) ?? []
    bucket.push(body)
    bodiesByLicense.set(body.license, bucket)
  }
  for (const [license, group] of [...bodiesByLicense].sort(([a], [b]) => compareText(a, b))) {
    const packageCount = group.reduce((sum, body) => sum + body.packages.length, 0)
    lines.push(`## ${license}`, '', `${packageCount} package(s), ${group.length} text(s).`, '')
    for (const [index, body] of group.entries()) {
      lines.push(
        `### Text ${index + 1} of ${group.length} — ${body.packages.length} package(s)`,
        ''
      )
      const fence = fenceFor(body.text)
      lines.push(fence, body.text, fence, '', 'Packages:', '')
      lines.push(...body.packages.map(describePackage), '')
    }
  }

  const withoutBody = report.groups.flatMap((group) =>
    group.packages.filter((pkg) => pkg.copyrightSource !== 'license-file')
  )
  if (withoutBody.length > 0) {
    lines.push(
      '## Packages without a licence file',
      '',
      'The copyright line, when there is one, comes from the manifest author field.',
      'A package listed without one states nothing to reproduce.',
      '',
      ...withoutBody.map(describePackage),
      ''
    )
  }
  return `${lines.join('\n').trimEnd()}\n`
}

export function writeLicenseNotices(notices: LicenseNotices, target: string = NOTICES_PATH): void {
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, renderNoticeMarkdown(notices))
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
  const notices = buildLicenseNotices(readLicenseJson())
  writeLicenseReport(notices.report)
  writeLicenseNotices(notices)
  // One line: a build log that does not say what it generated cannot be checked.
  console.log(
    `[licenses] ${notices.report.total} packages under ${notices.report.groups.length} licences, ${notices.report.texts.length} distinct bodies`
  )
}
