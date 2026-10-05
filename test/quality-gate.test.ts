import { describe, expect, test } from 'bun:test'

import {
  AISLOP_MINIMUM_SCORE,
  type AislopReport,
  evaluateAislopReport,
  parseAislopReport,
} from '../scripts/quality/aislop.ts'
import {
  compareVersions,
  excuseRecentReleases,
  isOutdatedRowNoise,
  minimumReleaseAgeDays,
  outdatedRowName,
  outdatedRowVersion,
  parseOutdatedDependencies,
  validateBunToolchain,
} from '../scripts/quality/dependencies.ts'
import { SOCKET_SCAN_COMMAND } from '../scripts/quality/local-gate.ts'

function aislopReport(overrides: Partial<AislopReport> = {}): AislopReport {
  return {
    score: 96,
    summary: {
      errors: 0,
      warnings: 2,
      fixable: 1,
      files: 120,
      elapsed: '1.2s',
    },
    diagnostics: [
      {
        filePath: 'src/example.ts',
        rule: 'ai-slop/trivial-comment',
        severity: 'warning',
        message: 'Remove a trivial comment',
        line: 4,
        column: 2,
        fixable: true,
      },
    ],
    ...overrides,
  }
}

describe('local quality gate helpers', () => {
  test('compares semantic versions and enforces the Bun baseline', () => {
    expect(compareVersions('1.4.2', '1.4.1')).toBe(1)
    expect(compareVersions('2.0.0', '2.0.0')).toBe(0)
    expect(compareVersions('1.3.9', '1.4.2')).toBe(-1)
    expect(() => validateBunToolchain('1.4.2', 'bun@1.4.2')).not.toThrow()
    expect(() => validateBunToolchain('1.4.3', 'bun@1.4.2')).not.toThrow()
    expect(() => validateBunToolchain('1.4.1', 'bun@1.4.2')).toThrow('Bun 1.4.2+ is required')
    expect(() => validateBunToolchain('1.4.2', 'bun@1.3.8')).toThrow('packageManager')
  })

  describe('the release-age window', () => {
    const DAY = 24 * 60 * 60 * 1000
    const NOW = Date.parse('2026-10-05T12:00:00Z')
    const row = (name: string, latest: string): string => `| ${name} | 1.0.0 | 1.0.0 | ${latest} |`

    test('reads the window from renovate.json, so the gate and the bot cannot disagree', async () => {
      // One home for "how new is too new". If the gate hard-coded its own number,
      // the bot and the gate would drift and one of them would be lying.
      expect(await minimumReleaseAgeDays()).toBe(1)
    })

    test('waits out a release that is younger than the window', async () => {
      const fresh = async (): Promise<number> => NOW - 3 * 60 * 60 * 1000
      const kept = await excuseRecentReleases([row('vite', '9.0.0')], 1, fresh, NOW)
      expect(kept).toEqual([])
    })

    test('still reports a release that has settled', async () => {
      const settled = async (): Promise<number> => NOW - 5 * DAY
      const rows = [row('vite', '9.0.0')]
      expect(await excuseRecentReleases(rows, 1, settled, NOW)).toEqual(rows)
    })

    test('reports everything when the window is zero, rather than excusing all', async () => {
      const rows = [row('vite', '9.0.0')]
      expect(await excuseRecentReleases(rows, 0, async () => NOW, NOW)).toEqual(rows)
    })

    // A lookup that fails must not turn the gate green: that is the failure mode a
    // network hiccup would otherwise produce.
    test('reports a dependency whose release date could not be determined', async () => {
      const rows = [row('vite', '9.0.0')]
      const unknown = async (): Promise<null> => null
      expect(await excuseRecentReleases(rows, 1, unknown, NOW)).toEqual(rows)
    })

    // Once the real findings are excused, the header and separator lines are all
    // that is left. Keeping them failed the gate on an EMPTY table, which reads as
    // a broken check rather than as "nothing to do".
    test('drops the table furniture instead of reporting it as a dependency', async () => {
      const furniture = [
        '|--------------------------------------------------------|',
        '| Package                    | Current | Update | Latest |',
        '|----------------------------|---------|--------|--------|',
        '|--------------------------------------------------------|',
      ]
      // A settled publish time, so the age rule excuses nothing and only the
      // furniture rule can be what drops these. With a fresh time they would be
      // excused anyway, and the test would pass for the wrong reason.
      const settled = async (): Promise<number> => NOW - 5 * DAY
      expect(await excuseRecentReleases(furniture, 1, settled, NOW)).toEqual([])
    })

    // The opposite failure mode: something the parser does not recognise must
    // still be reported, or a parsing regression would pass the gate quietly.
    test('reports a row whose release date could not be read', async () => {
      const rows = ['| @unknown/dep | 1.0.0 | 1.0.1 | 1.0.1 |']
      expect(await excuseRecentReleases(rows, 1, async () => null, NOW)).toEqual(rows)
    })
  })

  describe('reading an outdated row', () => {
    // bun annotates the name with where it comes from, and those annotations are
    // not part of the name. A lookup that keeps them 404s, which reads as "date
    // unknown", which reads as "old enough" - so the gate then fails on exactly
    // the release it meant to wait out. That is what these pin down.
    test('strips the annotation bun puts after the name', () => {
      expect(outdatedRowName('| @vitejs/plugin-react (dev) | 6.1.1   | 6.1.2  | 6.1.2  |')).toBe(
        '@vitejs/plugin-react'
      )
      expect(outdatedRowName('| open (optional) | 11.0.3 | 11.0.4 | 11.0.4 |')).toBe('open')
      expect(outdatedRowName('| typescript (peer) | 7.0.1 | 7.0.2 | 7.0.2 |')).toBe('typescript')
    })

    test('leaves an unannotated name alone', () => {
      expect(outdatedRowName('| ghostty-web | 1.0.0 | 1.0.1 | 1.0.1 |')).toBe('ghostty-web')
      // A scoped name with no annotation must survive intact, slash included.
      expect(outdatedRowName('| @opencode/plugin | 2.0.23 | 2.0.24 | 2.0.24 |')).toBe(
        '@opencode/plugin'
      )
    })

    test('returns nothing for a row with no name at all', () => {
      expect(outdatedRowName('| | | | |')).toBe('')
      expect(outdatedRowName('kein table hier')).toBe('')
    })

    test('recognises furniture without mistaking a dependency for it', () => {
      expect(isOutdatedRowNoise('|--------------------|')).toBe(true)
      expect(isOutdatedRowNoise('| Package | Current | Update | Latest |')).toBe(true)
      expect(isOutdatedRowNoise('|  package |')).toBe(true)
      expect(isOutdatedRowNoise('| vite | 8.3.0 | 8.3.1 | 8.4.0 |')).toBe(false)
      // A dependency whose name merely starts with "package" is a dependency.
      expect(isOutdatedRowNoise('| package-json | 1.0.0 | 1.0.1 | 1.0.1 |')).toBe(false)
    })

    test('reads the version the row would move to', () => {
      expect(outdatedRowVersion('| vite | 8.3.0 | 8.3.1 | 8.4.0 |')).toBe('8.3.1')
    })

    test('has no version when the update column names nothing usable', () => {
      expect(outdatedRowVersion('| vite | 8.3.0 | Latest | 8.4.0 |')).toBe('')
      expect(outdatedRowVersion('| vite | | | |')).toBe('')
    })
  })

  test('treats only lines after the bun outdated header as findings', () => {
    expect(parseOutdatedDependencies('bun outdated v1.4.2 (abcdef)\n')).toEqual([])
    expect(
      parseOutdatedDependencies(
        'bun outdated v1.4.2 (abcdef)\n\nPackage  Current  Wanted  Latest\nvite     8.3.0   8.3.1   8.4.0'
      )
    ).toEqual(['Package  Current  Wanted  Latest', 'vite     8.3.0   8.3.1   8.4.0'])
  })

  test('pins Socket to the authenticated CLI policy scan', () => {
    expect([...SOCKET_SCAN_COMMAND]).toEqual(['bunx', 'socket@1.1.180', 'ci'])
  })

  test('parses Aislop JSON and applies the selected score gate', () => {
    const report = parseAislopReport(JSON.stringify(aislopReport()))
    expect(report.score).toBe(96)
    expect(report.diagnostics[0]?.rule).toBe('ai-slop/trivial-comment')
    expect(evaluateAislopReport(report)).toEqual({ passed: true, reasons: [] })
  })

  test('fails Aislop for errors or a score below the configured minimum', () => {
    const errorReport = aislopReport({
      summary: { ...aislopReport().summary, errors: 1 },
    })
    expect(evaluateAislopReport(errorReport).reasons).toEqual(['1 error(s)'])
    const lowScoreReport = aislopReport({ score: AISLOP_MINIMUM_SCORE - 1 })
    expect(evaluateAislopReport(lowScoreReport).reasons).toEqual([
      `score ${AISLOP_MINIMUM_SCORE - 1} is below ${AISLOP_MINIMUM_SCORE}`,
    ])
  })

  test('rejects malformed Aislop JSON', () => {
    expect(() => parseAislopReport('not json')).toThrow()
    expect(() => parseAislopReport('{"score":96,"diagnostics":[]}')).toThrow(
      'summary must be an object'
    )
  })
})
