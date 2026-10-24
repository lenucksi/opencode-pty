import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildLicenseReport, renderLicenseReport } from '../scripts/licenses.ts'
import { handleLicenses, parseLicenseReport } from '../src/web/server/handlers/licenses.ts'
import {
  LICENSE_CREDITS,
  type LicenseReport,
  type LicensesResponse,
} from '../src/web/shared/licenses.ts'

/**
 * The notice list is generated, so the two things that can go wrong are:
 * the generator writes a report that is not reproducible (then the artifact is
 * a new file on every build and its diff is noise), and the handler serves a
 * shape the client cannot render. Both are checked without a build and without
 * touching the real `dist/`.
 */

const tempRoots: string[] = []

afterAll(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Bun's report, with the volatile fields that must not survive. */
const BUN_REPORT = {
  MIT: [
    {
      name: 'zeta',
      versions: ['2.0.0'],
      paths: ['/home/someone/node_modules/zeta'],
      author: 'Someone',
      description: 'Not copied into the artifact',
      homepage: 'https://example.invalid/zeta',
    },
    { name: 'react', versions: ['19.3.1', '18.3.1'] },
  ],
  '0BSD': [{ name: 'tslib', versions: ['2.8.1'] }],
  'Apache-2.0': [
    { name: 'alpha', versions: ['1.0.0'] },
    { name: 'alpha', versions: ['0.9.0'] },
  ],
}

function writeArtifact(report: LicenseReport): string {
  const root = mkdtempSync(join(tmpdir(), 'agentterm-licenses-'))
  tempRoots.push(root)
  const path = join(root, 'licenses.json')
  writeFileSync(path, renderLicenseReport(report))
  return path
}

describe('buildLicenseReport', () => {
  it('groups packages by licence, sorted, with a count per group', () => {
    const report = buildLicenseReport(BUN_REPORT)

    expect(report.groups.map((group) => group.license)).toEqual(['0BSD', 'Apache-2.0', 'MIT'])
    // Packages are sorted by name and then version; a duplicated install of one
    // package at two versions is two rows, not one.
    expect(report.groups[2]?.packages.map((pkg) => `${pkg.name}@${pkg.version}`)).toEqual([
      'react@18.3.1',
      'react@19.3.1',
      'zeta@2.0.0',
    ])
    expect(report.groups.map((group) => group.count)).toEqual([1, 2, 3])
    expect(report.total).toBe(6)
  })

  it('does not copy paths, authors, descriptions or homepages into the artifact', () => {
    const rendered = renderLicenseReport(buildLicenseReport(BUN_REPORT))

    expect(rendered).not.toContain('node_modules')
    expect(rendered).not.toContain('/home/someone')
    expect(rendered).not.toContain('Someone')
    expect(rendered).not.toContain('example.invalid')
  })

  it('renders byte-identically for the same lockfile, whatever the input order', () => {
    const reversed = Object.fromEntries(Object.entries(BUN_REPORT).reverse())
    const first = renderLicenseReport(buildLicenseReport(BUN_REPORT))
    const second = renderLicenseReport(buildLicenseReport(reversed))

    expect(second).toBe(first)
    // Sorted on the way in as well, so two calls on the same report agree.
    expect(renderLicenseReport(buildLicenseReport(BUN_REPORT))).toBe(first)
  })

  it('tolerates an empty or malformed report instead of failing the build', () => {
    expect(buildLicenseReport(null)).toEqual({ total: 0, groups: [] })
    expect(
      buildLicenseReport({
        MIT: [null, {}, { name: '' }, { name: 'kept' }],
        broken: 'not an array',
      })
    ).toEqual({
      total: 1,
      groups: [
        {
          license: 'MIT',
          count: 1,
          packages: [{ name: 'kept', version: 'unknown', license: 'MIT' }],
        },
      ],
    })
  })

  it('drops a duplicate package row rather than listing one install twice', () => {
    const report = buildLicenseReport({
      MIT: [
        { name: 'twice', versions: ['1.0.0'] },
        { name: 'twice', versions: ['1.0.0'] },
      ],
    })

    expect(report.total).toBe(1)
  })
})

describe('parseLicenseReport', () => {
  it('rejects a document that is not one', () => {
    expect(parseLicenseReport('not json')).toBeNull()
    expect(parseLicenseReport('{"groups": 3}')).toBeNull()
    expect(parseLicenseReport('null')).toBeNull()
  })

  it('recomputes the count from the packages it kept', () => {
    const report = parseLicenseReport(
      JSON.stringify({
        total: 999,
        groups: [
          {
            license: 'MIT',
            count: 999,
            packages: [{ name: 'kept', version: '1', license: 'MIT' }],
          },
        ],
      })
    )

    expect(report).toEqual({
      total: 1,
      groups: [
        { license: 'MIT', count: 1, packages: [{ name: 'kept', version: '1', license: 'MIT' }] },
      ],
    })
  })
})

describe('GET /api/licenses', () => {
  it('serves the generated report with the hand-written credits', async () => {
    const path = writeArtifact(buildLicenseReport(BUN_REPORT))
    const response = handleLicenses(path)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json')
    const payload = (await response.json()) as LicensesResponse
    expect(payload.available).toBe(true)
    expect(payload.total).toBe(6)
    expect(payload.groups.map((group) => group.license)).toEqual(['0BSD', 'Apache-2.0', 'MIT'])
    expect(payload.credits).toEqual([...LICENSE_CREDITS])
    expect(payload.credits.map((credit) => credit.name)).toEqual([
      'OpenCode',
      'bun-pty',
      'ghostty-web',
      'shekohex/opencode-pty',
    ])
  })

  it('carries the security headers the older JSON handlers do not', () => {
    const response = handleLicenses(writeArtifact(buildLicenseReport(BUN_REPORT)))

    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('x-frame-options')).toBe('DENY')
    expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin')
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'")
  })

  it('answers a build with no artifact instead of 404, and still names the credits', async () => {
    const response = handleLicenses(join(tmpdir(), 'agentterm-licenses-missing', 'licenses.json'))

    expect(response.status).toBe(200)
    const payload = (await response.json()) as LicensesResponse
    expect(payload.available).toBe(false)
    expect(payload.total).toBe(0)
    expect(payload.groups).toEqual([])
    expect(payload.credits.length).toBe(4)
  })
})
