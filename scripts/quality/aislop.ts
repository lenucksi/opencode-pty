import { activeAuditExceptions, TEMPORARY_AUDIT_EXCEPTIONS } from './dependencies.ts'
import { captureCommand } from './process.ts'

export const AISLOP_MINIMUM_SCORE = 90

export interface AislopDiagnostic {
  filePath: string
  rule: string
  severity: string
  message: string
  line: number
  column: number
  fixable: boolean
}

export interface AislopSummary {
  errors: number
  warnings: number
  fixable: number
  files: number
  elapsed: string
}

export interface AislopReport {
  score: number
  summary: AislopSummary
  diagnostics: AislopDiagnostic[]
}

export interface AislopEvaluation {
  passed: boolean
  reasons: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string') throw new Error(`Aislop ${key} must be a string`)
  return value
}

function readNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Aislop ${key} must be a finite number`)
  }
  return value
}

function readBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key]
  if (typeof value !== 'boolean') throw new Error(`Aislop ${key} must be a boolean`)
  return value
}

function parseSummary(value: unknown): AislopSummary {
  if (!isRecord(value)) throw new Error('Aislop summary must be an object')
  return {
    errors: readNumber(value, 'errors'),
    warnings: readNumber(value, 'warnings'),
    fixable: readNumber(value, 'fixable'),
    files: readNumber(value, 'files'),
    elapsed: readString(value, 'elapsed'),
  }
}

function parseDiagnostic(value: unknown): AislopDiagnostic {
  if (!isRecord(value)) throw new Error('Aislop diagnostic must be an object')
  return {
    filePath: readString(value, 'filePath'),
    rule: readString(value, 'rule'),
    severity: readString(value, 'severity'),
    message: readString(value, 'message'),
    line: readNumber(value, 'line'),
    column: readNumber(value, 'column'),
    fixable: readBoolean(value, 'fixable'),
  }
}

export function parseAislopReport(output: string): AislopReport {
  const value: unknown = JSON.parse(output)
  if (!isRecord(value)) throw new Error('Aislop output must be an object')
  const diagnosticsValue = value.diagnostics
  if (!Array.isArray(diagnosticsValue)) {
    throw new Error('Aislop diagnostics must be an array')
  }
  return {
    score: readNumber(value, 'score'),
    summary: parseSummary(value.summary),
    diagnostics: diagnosticsValue.map(parseDiagnostic),
  }
}

/**
 * The audit exception and Aislop's own dependency rule have to agree.
 *
 * Aislop does not read bun's `--ignore` flags; it runs its own advisory check and reports
 * a finding on `package.json`, where JSON cannot carry an inline suppression comment. The
 * only honest way to keep the two checks consistent is to filter that one finding here,
 * for exactly as long as the audit exception is open, and to print it on every run.
 */
export function isToleratedAislopFinding(
  diagnostic: AislopDiagnostic,
  now: Date = new Date()
): boolean {
  if (
    diagnostic.rule !== 'security/vulnerable-dependency' ||
    diagnostic.filePath !== 'package.json'
  ) {
    return false
  }
  const active = activeAuditExceptions(now)
  return TEMPORARY_AUDIT_EXCEPTIONS.some(
    (entry) => active.includes(entry.id) && diagnostic.message.startsWith(`${entry.package} (`)
  )
}

export function evaluateAislopReport(
  report: AislopReport,
  now: Date = new Date()
): AislopEvaluation {
  const tolerated = report.diagnostics.filter((item) => isToleratedAislopFinding(item, now)).length
  const errors = Math.max(0, report.summary.errors - tolerated)
  const reasons: string[] = []
  if (errors > 0) {
    reasons.push(`${errors} error(s)`)
  }
  if (report.score < AISLOP_MINIMUM_SCORE) {
    reasons.push(`score ${report.score} is below ${AISLOP_MINIMUM_SCORE}`)
  }
  return { passed: reasons.length === 0, reasons }
}

function formatDiagnostic(diagnostic: AislopDiagnostic): string {
  const position = diagnostic.line > 0 ? `:${diagnostic.line}:${diagnostic.column}` : ''
  const fixable = diagnostic.fixable ? ' [fixable]' : ''
  return `${diagnostic.severity} ${diagnostic.filePath}${position} [${diagnostic.rule}] ${diagnostic.message}${fixable}`
}

export function formatAislopReport(report: AislopReport): string {
  const lines = [
    `Aislop score: ${report.score}/100`,
    `Files: ${report.summary.files}; errors: ${report.summary.errors}; warnings: ${report.summary.warnings}; fixable: ${report.summary.fixable}`,
  ]
  lines.push(...report.diagnostics.map(formatDiagnostic))
  return lines.join('\n')
}

export async function runAislopCheck(): Promise<void> {
  // Aislop exits 1 whenever it has an error finding, even when the report is valid JSON
  // and the gate's own evaluation tolerates that one finding. Let the report decide.
  const result = await captureCommand('bunx', ['aislop@0.16.1', 'scan', '.', '--json'], {
    allowedExitCodes: [1],
  })
  const report = parseAislopReport(result.stdout)
  console.log(formatAislopReport(report))
  for (const diagnostic of report.diagnostics) {
    if (isToleratedAislopFinding(diagnostic)) {
      console.warn(
        `[aislop] TOLERATED ${diagnostic.message} (audit exception, expires with the bun audit exception)`
      )
    }
  }
  const evaluation = evaluateAislopReport(report)
  if (!evaluation.passed) {
    throw new Error(`Aislop gate failed: ${evaluation.reasons.join(', ')}`)
  }
}
