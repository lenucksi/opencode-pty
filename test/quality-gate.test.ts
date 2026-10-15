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
  outdatedRowTarget,
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

    // The case the whole change exists for, and the one a suite of pure-function tests
    // cannot reach: WHICH version does the gate ask the registry about?
    //
    // An exactly-pinned dependency prints the current version in its Update column,
    // because nothing a `bun update` could install falls inside an exact pin. Asking about
    // that returns an age of months, so the gate could never wait the release out and
    // demanded a same-day bump - the one outcome `minimumReleaseAge` exists to prevent. The
    // candidate is the newest release, which is what the manifest edit would take.
    test('asks about the release a bump would take, not the one already installed', async () => {
      const asked: Array<[string, string]> = []
      const pinned = '| @opencode/theme (dev) | 2.0.23 | 2.0.23 | 2.0.24 |'
      await excuseRecentReleases(
        [pinned],
        1,
        async (name, version) => {
          asked.push([name, version])
          return NOW - 60 * 60 * 1000
        },
        NOW
      )
      expect(asked).toEqual([['@opencode/theme', '2.0.24']])
    })

    // The other direction, so the fix is not "always ask for the newest": a range the
    // current version still satisfies moves within itself, and that is the smaller bump.
    test('asks about the in-range update when the range can still move', async () => {
      const asked: string[] = []
      await excuseRecentReleases(
        ['| vite | 8.3.2 | 8.3.3 | 9.0.0 |'],
        1,
        async (_name, version) => {
          asked.push(version)
          return NOW
        },
        NOW
      )
      expect(asked).toEqual(['8.3.3'])
    })

    // And the decision itself, not only the question: a one-hour-old candidate inside a
    // one-day window is waited out, so the gate passes instead of demanding it today.
    test('waits out a pinned dependency whose newest release is inside the window', async () => {
      // Absent from the result IS the wait: `excuseRecentReleases` returns what is old
      // enough to act on, so a candidate younger than the window is filtered out of it.
      const pinned = '| @opencode/theme (dev) | 2.0.23 | 2.0.23 | 2.0.24 |'
      const hourOld = async (): Promise<number> => NOW - 60 * 60 * 1000
      expect(await excuseRecentReleases([pinned], 1, hourOld, NOW)).toEqual([])
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

    test('reads the version a range would move to', () => {
      expect(outdatedRowTarget('| vite | 8.3.0 | 8.3.1 | 8.4.0 |')).toBe('8.3.1')
    })

    // An exact pin cannot move within itself, so the candidate is the newest release - which
    // is the manifest edit a bump actually requires. Reading the Update column here returned
    // the CURRENT version, whose age is always far past `minimumReleaseAge`, and the gate
    // could then never wait out a release for a pinned dependency: it demanded it the same
    // day. The `(dev)` row for @opencode/theme failed while the `(peer)` row of the same
    // package waited it out.
    test('reads the newest release for an exact pin, which cannot move within itself', () => {
      expect(outdatedRowTarget('| @opencode/theme (dev) | 2.0.23 | 2.0.23 | 2.0.24 |')).toBe(
        '2.0.24'
      )
    })

    // Same package, same newest release, two rows: they must agree, or the gate answers
    // the same question two ways in one run.
    test('gives one answer for the same package in both of its rows', () => {
      const pinned = outdatedRowTarget('| @opencode/theme (dev) | 2.0.23 | 2.0.23 | 2.0.24 |')
      const peer = outdatedRowTarget('| @opencode/theme (peer) | 2.0.23 | 2.0.24 | 2.0.24 |')
      expect(pinned).toBe(peer)
    })

    // Out of range: `Update` says only "Latest", and the manifest has to change.
    test('falls back to the newest release when the range has moved past it', () => {
      expect(outdatedRowTarget('| vite | 8.3.0 | Latest | 8.4.0 |')).toBe('8.4.0')
    })

    test('has no version when no column names anything usable', () => {
      expect(outdatedRowTarget('| vite | | | |')).toBe('')
      expect(outdatedRowTarget('| vite | 8.3.0 | 8.3.0 | 8.3.0 |')).toBe('')
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
