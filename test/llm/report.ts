/**
 * What a run looks like when it is printed.
 *
 * Separated from the runner so the reporting can be asserted on without
 * spending a token. Every line names the model, because the numbers below it
 * are only meaningful next to the model that produced them.
 */

import type { ScenarioOutcome } from './evaluate.ts'
import type { CheckResult } from './facts.ts'
import type { Scenario } from './scenarios.ts'

export function formatCheck(check: CheckResult): string {
  const mark = check.status === 'pass' ? 'PASS' : check.status === 'fail' ? 'FAIL' : 'SKIP'
  return `[${mark}] ${check.name}: ${check.detail}`
}

export function formatOutcome(outcome: ScenarioOutcome): string {
  const { metrics } = outcome
  const tokens = metrics.inputTokens + metrics.outputTokens + metrics.reasoningTokens
  const lines = [
    `${outcome.status.toUpperCase().padEnd(12)} ${outcome.scenarioId}  model=${outcome.model}`,
    `             ${(metrics.durationMs / 1000).toFixed(1)}s  steps=${metrics.steps}  ` +
      `tokens=${tokens} (in ${metrics.inputTokens} / out ${metrics.outputTokens} / ` +
      `reasoning ${metrics.reasoningTokens} / cache-read ${metrics.cacheReadTokens})  ` +
      `cost=${metrics.cost.toFixed(4)}`,
    `             pty calls=${metrics.ptyToolCalls} in ${metrics.hostToolCalls} host tool call(s); ` +
      `shell=${metrics.shellCommands}`,
  ]
  for (const check of outcome.checks) lines.push(`             ${formatCheck(check)}`)
  for (const warning of outcome.warnings) lines.push(`             warn: ${warning}`)
  return lines.join('\n')
}

export interface ScenarioTally {
  pass: number
  fail: number
  inconclusive: number
}

export function tally(outcomes: readonly ScenarioOutcome[]): Map<string, ScenarioTally> {
  const byScenario = new Map<string, ScenarioTally>()
  for (const outcome of outcomes) {
    const bucket: ScenarioTally = byScenario.get(outcome.scenarioId) ?? {
      pass: 0,
      fail: 0,
      inconclusive: 0,
    }
    bucket[outcome.status] += 1
    byScenario.set(outcome.scenarioId, bucket)
  }
  return byScenario
}

export function formatSummary(outcomes: readonly ScenarioOutcome[]): string {
  const rows: string[] = []
  let totalSeconds = 0
  let totalTokens = 0
  let totalCost = 0
  for (const [id, bucket] of tally(outcomes)) {
    const runs = bucket.pass + bucket.fail + bucket.inconclusive
    const rate = runs === 0 ? 0 : Math.round((bucket.pass / runs) * 100)
    const note = bucket.inconclusive > 0 ? `  ${bucket.inconclusive} inconclusive` : ''
    rows.push(`  ${id.padEnd(22)} ${bucket.pass}/${runs} passed (${rate}%)${note}`)
  }
  for (const outcome of outcomes) {
    totalSeconds += outcome.metrics.durationMs / 1000
    totalTokens +=
      outcome.metrics.inputTokens + outcome.metrics.outputTokens + outcome.metrics.reasoningTokens
    totalCost += outcome.metrics.cost
  }
  const models = [...new Set(outcomes.map((outcome) => outcome.model))]
  return [
    '',
    '=== summary ===',
    ...rows,
    `  ${'total'.padEnd(22)} ${outcomes.length} run(s) on ${models.join(', ')}, ` +
      `${totalSeconds.toFixed(1)}s wall clock, ${totalTokens} tokens, cost ${totalCost.toFixed(4)}`,
  ].join('\n')
}

export function formatScenarioList(scenarios: readonly Scenario[]): string {
  return scenarios
    .map(
      (scenario) =>
        `${scenario.id.padEnd(22)} ${scenario.title}\n${' '.repeat(23)}${scenario.intent}\n`
    )
    .join('\n')
}
