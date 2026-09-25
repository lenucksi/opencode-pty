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

export function evaluateAislopReport(report: AislopReport): AislopEvaluation {
  const reasons: string[] = []
  if (report.summary.errors > 0) {
    reasons.push(`${report.summary.errors} error(s)`)
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
  const result = await captureCommand('bunx', ['aislop@0.16.1', 'scan', '.', '--json'])
  const report = parseAislopReport(result.stdout)
  console.log(formatAislopReport(report))
  const evaluation = evaluateAislopReport(report)
  if (!evaluation.passed) {
    throw new Error(`Aislop gate failed: ${evaluation.reasons.join(', ')}`)
  }
}
