import { afterAll, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { extractCopyrightLines, normaliseLicenseText } from '../scripts/license-files.ts'
import {
  buildLicenseNotices,
  buildLicenseReport,
  renderLicenseReport,
  renderNoticeMarkdown,
  writeLicenseNotices,
  writeLicenseReport,
} from '../scripts/licenses.ts'
import { handleLicenses, parseLicenseReport } from '../src/web/server/handlers/licenses.ts'
import {
  LICENSE_CREDITS,
  type LicensePackage,
  type LicenseReport,
  type LicensesResponse,
} from '../src/web/shared/licenses.ts'
import {
  cleanupLicenceTrees,
  licenceScratchDir,
  makeTree,
  rawReport,
  readLicenseFixture,
} from './fixtures/licenses/tree.ts'

/**
 * The notice list is generated, so the things that can go wrong are: the report
 * is not reproducible (then the artifact is a new file on every build and its
 * diff is noise), the copyright lines are wrong or missing (then the notice does
 * not satisfy the licence it reproduces), and the handler serves a shape the
 * client cannot render. All three are checked without a build and without
 * touching the real `dist/`.
 */

afterAll(cleanupLicenceTrees)

const TREE = makeTree([
  { name: 'mit-a', version: '1.0.0', license: 'mit-one-line.txt' },
  { name: 'mit-b', version: '2.0.0', license: 'mit-one-line.txt' },
  { name: '@scope/scoped', version: '1.0.0', license: 'mit-one-line.txt' },
  { name: 'mit-other', version: '1.0.0', license: 'mit-wrapped.txt', licenseName: 'LICENSE.md' },
  { name: 'bsd', version: '0.5.0', license: 'bsd-2-clause.txt', licenseName: 'LICENSE.txt' },
  { name: 'apache', version: '3.1.0', license: 'apache-header.txt', licenseName: 'LICENCE' },
  { name: 'host', version: '1.0.0', author: 'Host Author' },
  {
    name: 'nested-copy',
    version: '4.0.0',
    license: 'bsd-2-clause.txt',
    licenseName: 'COPYING',
    dir: 'host/node_modules/nested-copy',
  },
  { name: 'host-object', version: '1.0.0', author: { name: 'Object Author' } },
  { name: 'authorless', version: '1.0.0' },
  {
    name: 'both-files',
    version: '1.0.0',
    license: 'mit-wrapped.txt',
    notice: 'Copyright (c) 1999 Notice Holder\n',
  },
  { name: 'broken', version: '1.0.0', unreadable: true, author: 'Ignored Author' },
  {
    name: 'split-license',
    version: '1.0.0',
    license: 'mit-wrapped.txt',
    licenseName: 'LICENSE-MIT',
  },
  { name: 'git-dep', version: '0.3.0', license: 'mit-one-line.txt' },
  { name: 'blueoak', version: '1.0.0', license: 'blueoak.txt', licenseName: 'LICENSE.md' },
])

const REPORT = rawReport([
  { license: 'MIT', name: 'mit-a' },
  { license: 'MIT', name: 'mit-b', versions: ['2.0.0'] },
  { license: 'MIT', name: '@scope/scoped' },
  { license: 'MIT', name: 'mit-other' },
  { license: 'MIT', name: 'host' },
  { license: 'MIT', name: 'host-object' },
  { license: 'MIT', name: 'authorless' },
  { license: 'MIT', name: 'both-files' },
  { license: 'MIT', name: 'broken' },
  { license: 'MIT', name: 'split-license' },
  { license: 'MIT', name: 'git-dep', versions: ['github:example/git-dep#abc123'] },
  { license: 'MIT', name: 'blueoak' },
  { license: 'BSD-2-Clause', name: 'bsd', versions: ['0.5.0'] },
  { license: 'BSD-2-Clause', name: 'nested-copy', versions: ['4.0.0'] },
  { license: 'Apache-2.0', name: 'apache', versions: ['3.1.0'] },
])

function build(): LicenseReport {
  return buildLicenseReport(REPORT, { nodeModulesRoot: TREE })
}

function pkg(report: LicenseReport, name: string, version = '1.0.0'): LicensePackage | undefined {
  return report.groups
    .flatMap((group) => group.packages)
    .find((p) => {
      return p.name === name && p.version === version
    })
}

function reversed(value: Record<string, unknown[]>): Record<string, unknown[]> {
  const entries = Object.entries(value).reverse()
  return Object.fromEntries(entries.map(([license, rows]) => [license, [...rows].reverse()]))
}

describe('extractCopyrightLines', () => {
  it('reads a one-line MIT notice with its year', () => {
    expect(extractCopyrightLines(readLicenseFixture('mit-one-line.txt'))).toEqual([
      'Copyright (c) 2010-2024 Isaac Z. Schlueter and Contributors',
    ])
  })

  it('folds a wrapped notice onto one line', () => {
    expect(extractCopyrightLines(readLicenseFixture('mit-wrapped.txt'))).toEqual([
      'Copyright (c) 2011-2019 Some Person and the Other Contributors',
    ])
  })

  it('reads the © form and stops before the sentence beneath it', () => {
    expect(extractCopyrightLines(readLicenseFixture('bsd-2-clause.txt'))).toEqual([
      'Copyright © 2013, Example Authors',
    ])
  })

  it('reads an Apache header', () => {
    expect(extractCopyrightLines(readLicenseFixture('apache-header.txt'))).toEqual([
      'Copyright 2024 Example Corp.',
    ])
  })

  it('reproduces the Apache appendix placeholder rather than inventing an owner', () => {
    const appendix = 'Copyright [yyyy] [name of copyright owner]\n'
    expect(extractCopyrightLines(appendix)).toEqual(['Copyright [yyyy] [name of copyright owner]'])
  })

  it('does not mistake a licence clause for a notice', () => {
    expect(
      extractCopyrightLines(
        'THE AUTHORS OR\nCOPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM\n\ncopyright notice and this permission notice appear in all copies.\n\nsoftware that would otherwise infringe contributor\ncopyright in it.\n'
      )
    ).toEqual([])
  })

  it('recognises an all-caps notice when a year follows it', () => {
    expect(extractCopyrightLines('COPYRIGHT (C) 1998 Old Co.\n')).toEqual([
      'COPYRIGHT (C) 1998 Old Co.',
    ])
  })

  it('keeps two notices from one file and drops an exact repeat', () => {
    const text = 'Copyright (c) 2020 One\nCopyright (c) 2021 Two\nCopyright (c) 2020 One\n'
    expect(extractCopyrightLines(text)).toEqual([
      'Copyright (c) 2020 One',
      'Copyright (c) 2021 Two',
    ])
  })
})

describe('buildLicenseReport', () => {
  it('groups packages by licence, sorted, with a count per group', () => {
    const report = build()

    expect(report.groups.map((group) => group.license)).toEqual([
      'Apache-2.0',
      'BSD-2-Clause',
      'MIT',
    ])
    expect(report.groups.map((group) => group.count)).toEqual([1, 2, 12])
    expect(report.total).toBe(15)
    expect(report.groups[2]?.packages.map((row) => `${row.name}@${row.version}`)).toEqual([
      '@scope/scoped@1.0.0',
      'authorless@1.0.0',
      'blueoak@1.0.0',
      'both-files@1.0.0',
      'broken@1.0.0',
      'git-dep@github:example/git-dep#abc123',
      'host@1.0.0',
      'host-object@1.0.0',
      'mit-a@1.0.0',
      'mit-b@2.0.0',
      'mit-other@1.0.0',
      'split-license@1.0.0',
    ])
  })

  it('reads the copyright line out of each package, including scoped and nested copies', () => {
    const report = build()

    expect(pkg(report, 'mit-a')?.copyright).toEqual([
      'Copyright (c) 2010-2024 Isaac Z. Schlueter and Contributors',
    ])
    expect(pkg(report, '@scope/scoped')?.copyrightSource).toBe('license-file')
    // The nested copy is its own install under `host`, not the hoisted `bsd`.
    expect(pkg(report, 'nested-copy', '4.0.0')?.copyright).toEqual([
      'Copyright © 2013, Example Authors',
    ])
  })

  it('matches licence file names case-insensitively and prefers LICENSE over NOTICE', () => {
    const report = build()

    expect(pkg(report, 'apache', '3.1.0')?.copyrightSource).toBe('license-file')
    expect(pkg(report, 'mit-other')?.copyright).toEqual([
      'Copyright (c) 2011-2019 Some Person and the Other Contributors',
    ])
    expect(pkg(report, 'both-files')?.copyright).toEqual([
      'Copyright (c) 2011-2019 Some Person and the Other Contributors',
    ])
    // The split-licence convention: `LICENSE-MIT` and no plain `LICENSE`.
    expect(pkg(report, 'split-license')?.copyright).toEqual([
      'Copyright (c) 2011-2019 Some Person and the Other Contributors',
    ])
  })

  it('finds the install of a git dependency, whose reported version is a specifier', () => {
    const report = build()

    expect(pkg(report, 'git-dep', 'github:example/git-dep#abc123')?.copyright).toEqual([
      'Copyright (c) 2010-2024 Isaac Z. Schlueter and Contributors',
    ])
  })

  it('records a licence file that states no copyright rather than inventing one', () => {
    expect(pkg(build(), 'blueoak')).toMatchObject({
      copyright: [],
      copyrightSource: 'license-file',
    })
  })

  it('falls back to the manifest author, in either shape, when nothing is installed', () => {
    const report = build()

    expect(pkg(report, 'host')?.copyright).toEqual(['Host Author'])
    expect(pkg(report, 'host')?.copyrightSource).toBe('author-field')
    expect(pkg(report, 'host-object')?.copyright).toEqual(['Object Author'])
    expect(pkg(report, 'host-object')?.copyrightSource).toBe('author-field')
  })

  it('reports none rather than throwing for a missing or unreadable package', () => {
    const report = build()

    expect(pkg(report, 'authorless')).toMatchObject({ copyright: [], copyrightSource: 'none' })
    expect(pkg(report, 'broken')).toMatchObject({ copyright: [], copyrightSource: 'none' })
    expect(
      buildLicenseReport(rawReport([{ license: 'MIT', name: 'ghost' }]), {
        nodeModulesRoot: TREE,
      }).groups[0]?.packages[0]
    ).toMatchObject({ copyright: [], copyrightSource: 'none' })
  })

  it('reads a package directory that resolves outside the tree as nothing at all', () => {
    const root = licenceScratchDir()
    const outside = join(root, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'package.json'), '{"name":"escaped","version":"1.0.0"}')
    writeFileSync(join(outside, 'LICENSE'), 'Copyright (c) 1999 Outside Tree\n')
    const modules = join(root, 'node_modules')
    mkdirSync(modules)
    symlinkSync(outside, join(modules, 'escaped'))

    const reported = buildLicenseReport(rawReport([{ license: 'MIT', name: 'escaped' }]), {
      nodeModulesRoot: modules,
    })

    expect(reported.groups[0]?.packages[0]).toMatchObject({
      copyright: [],
      copyrightSource: 'none',
    })
  })

  it('keeps two MIT wordings as two bodies and collapses a shared one', () => {
    const report = build()

    expect(report.texts.map((text) => [text.license, text.packageCount])).toEqual([
      ['MIT', 4],
      ['MIT', 3],
      ['BSD-2-Clause', 2],
      ['Apache-2.0', 1],
      ['MIT', 1],
    ])
    // The shared body is the file, normalised, and it is the one three packages ship.
    const shared = report.texts[0]
    expect(shared?.text).toBe(normaliseLicenseText(readLicenseFixture('mit-one-line.txt')))
    expect(shared?.text).not.toBe(normaliseLicenseText(readLicenseFixture('mit-wrapped.txt')))
  })

  it('tolerates an empty or malformed report instead of failing the build', () => {
    expect(buildLicenseReport(null, { nodeModulesRoot: TREE })).toEqual({
      total: 0,
      groups: [],
      texts: [],
    })
    // A tree that is not installed yet is not an error: every package is `none`.
    const uninstalled = buildLicenseReport(REPORT, {
      nodeModulesRoot: join(tmpdir(), 'agentterm-licenses-not-installed', 'node_modules'),
    })
    expect(uninstalled.total).toBe(15)
    expect(uninstalled.texts).toEqual([])
    expect(
      uninstalled.groups
        .flatMap((group) => group.packages)
        .every((row) => {
          return row.copyrightSource === 'none' && row.copyright.length === 0
        })
    ).toBe(true)
    expect(
      buildLicenseReport(
        { MIT: [null, {}, { name: '' }, { name: 'kept' }], broken: 'not an array' },
        { nodeModulesRoot: TREE }
      )
    ).toEqual({
      total: 1,
      groups: [
        {
          license: 'MIT',
          count: 1,
          packages: [
            {
              name: 'kept',
              version: 'unknown',
              license: 'MIT',
              copyright: [],
              copyrightSource: 'none',
            },
          ],
        },
      ],
      texts: [],
    })
  })

  it("does not copy paths or Bun's own author field into the artifact", () => {
    const rendered = renderLicenseReport(build())

    expect(rendered).not.toContain('node_modules')
    expect(rendered).not.toContain('/home/someone')
    expect(rendered).not.toContain('Not copied')
  })
})

describe('renderNoticeMarkdown', () => {
  it('reproduces each body once and lists the packages that ship it', () => {
    const markdown = renderNoticeMarkdown(buildLicenseNotices(REPORT, { nodeModulesRoot: TREE }))
    const shared = normaliseLicenseText(readLicenseFixture('mit-one-line.txt'))

    expect(markdown).toContain('Generated at build time from the lockfile and `node_modules`')
    expect(markdown).toContain('## MIT')
    expect(markdown.split(shared)).toHaveLength(2)
    expect(markdown).toContain(
      '- `mit-a@1.0.0` — Copyright (c) 2010-2024 Isaac Z. Schlueter and Contributors'
    )
    expect(markdown).toContain('- `host@1.0.0` — Host Author')
    expect(markdown).toContain('- `authorless@1.0.0` — (no copyright line found)')
    expect(markdown).toContain('## Packages without a licence file')
  })

  it('renders a report with no packages without throwing', () => {
    const notices = buildLicenseNotices(null, { nodeModulesRoot: TREE })
    expect(renderNoticeMarkdown(notices)).toContain('# Third-party notices')
  })
})

describe('determinism', () => {
  it('writes byte-identical JSON and notice on two runs over one lockfile', () => {
    const hashes: string[] = []
    for (const source of [REPORT, reversed(REPORT)]) {
      const dir = licenceScratchDir()
      const notices = buildLicenseNotices(source, { nodeModulesRoot: TREE })
      writeLicenseReport(notices.report, join(dir, 'licenses.json'))
      writeLicenseNotices(notices, join(dir, 'THIRD-PARTY-NOTICES.md'))
      hashes.push(
        ...['licenses.json', 'THIRD-PARTY-NOTICES.md'].map((name) => {
          return createHash('sha256')
            .update(readFileSync(join(dir, name)))
            .digest('hex')
        })
      )
    }

    expect(hashes).toHaveLength(4)
    expect(hashes[2]).toBe(hashes[0])
    expect(hashes[3]).toBe(hashes[1])
    expect(hashes[0]).not.toBe(hashes[1])
  })
})

describe('parseLicenseReport', () => {
  it('rejects a document that is not one', () => {
    expect(parseLicenseReport('not json')).toBeNull()
    expect(parseLicenseReport('{"groups": 3}')).toBeNull()
    expect(parseLicenseReport('null')).toBeNull()
  })

  it('recomputes the count and serves an artifact from before the new fields', () => {
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
        {
          license: 'MIT',
          count: 1,
          packages: [
            { name: 'kept', version: '1', license: 'MIT', copyright: [], copyrightSource: 'none' },
          ],
        },
      ],
      texts: [],
    })
  })

  it('keeps what it can parse of the licence bodies', () => {
    const report = parseLicenseReport(
      JSON.stringify({
        groups: [],
        texts: [
          { license: 'MIT', text: 'kept', packageCount: 2 },
          { license: '', text: 'no licence id' },
          { license: 'MIT', text: 'counted as zero', packageCount: -3 },
          { license: 'MIT' },
          null,
        ],
      })
    )

    expect(report?.texts).toEqual([
      { license: 'MIT', text: 'kept', packageCount: 2 },
      { license: 'MIT', text: 'counted as zero', packageCount: 0 },
    ])
  })
})

describe('GET /api/licenses', () => {
  function writeArtifact(): string {
    const path = join(licenceScratchDir(), 'licenses.json')
    writeLicenseReport(build(), path)
    return path
  }

  it('serves the generated report with the hand-written credits', async () => {
    const response = handleLicenses(writeArtifact())

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json')
    const payload = (await response.json()) as LicensesResponse
    expect(payload.available).toBe(true)
    expect(payload.total).toBe(15)
    expect(payload.groups.map((group) => group.license)).toEqual([
      'Apache-2.0',
      'BSD-2-Clause',
      'MIT',
    ])
    expect(payload.texts.map((text) => text.packageCount)).toEqual([4, 3, 2, 1, 1])
    expect(pkg(payload, 'mit-a')?.copyright).toEqual([
      'Copyright (c) 2010-2024 Isaac Z. Schlueter and Contributors',
    ])
    expect(payload.credits).toEqual([...LICENSE_CREDITS])
  })

  it('carries the security headers the older JSON handlers do not', () => {
    const response = handleLicenses(writeArtifact())

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
    expect(payload.texts).toEqual([])
    expect(payload.credits.length).toBe(4)
  })
})
