import { describe, expect, test } from 'bun:test'

import {
  AISLOP_MINIMUM_SCORE,
  type AislopReport,
  evaluateAislopReport,
  parseAislopReport,
} from '../scripts/quality/aislop.ts'
import {
  compareVersions,
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
