/**
 * Turn one run into a verdict.
 *
 * Every case gets the same four generic checks - the plugin loaded, a session
 * was spawned, the run finished on its own, and the answer contains the token
 * the fixture only prints once the model has read far enough. Without those,
 * a case-specific pass could be about a plugin that never loaded.
 */

import { type Transcript, totalUsage } from './events.ts'
import { buildFacts, type CheckResult, countCalls, type RunFacts } from './facts.ts'
import type { Scenario } from './scenarios.ts'

export type { CheckResult, CheckStatus } from './facts.ts'

export interface RunMetrics {
  durationMs: number
  model: string
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cost: number
  steps: number
  ptyToolCalls: number
  hostToolCalls: number
  shellCommands: number
  exitCode: number | null
  timedOut: boolean
}

export interface ScenarioOutcome {
  scenarioId: string
  title: string
  model: string
  token: string
  status: 'pass' | 'fail' | 'inconclusive'
  checks: CheckResult[]
  facts: RunFacts
  metrics: RunMetrics
  answer: string
  warnings: string[]
  workspaceRoot: string
}

function genericChecks(options: {
  scenario: Scenario
  token: string
  facts: RunFacts
  resultCount: number
  producedOutput: string
}): CheckResult[] {
  const { scenario, token, facts } = options
  const checks: CheckResult[] = []

  checks.push(
    facts.pluginLoaded
      ? { name: 'plugin-loaded', status: 'pass', detail: 'the plugin logged its own startup' }
      : {
          name: 'plugin-loaded',
          status: 'fail',
          detail: 'the plugin never logged; the tools in this run may not have existed',
        }
  )

  const spawns = countCalls(facts.calls, 'pty_spawn')
  checks.push(
    spawns > 0
      ? { name: 'spawned-a-session', status: 'pass', detail: `${spawns} pty_spawn call(s)` }
      : {
          name: 'spawned-a-session',
          status: 'fail',
          detail: 'no pty_spawn call; the case never reached a PTY',
        }
  )

  // The fourth anti-pattern: throwing a session away discards the only record
  // of what it did. The kill tool says so and the skill says so; a model that
  // does it anyway is the finding, not a flake.
  checks.push(
    facts.discardedSessions.length === 0
      ? {
          name: 'no-session-discarded',
          status: 'pass',
          detail: 'every pty_kill kept the session and its buffer',
        }
      : {
          name: 'no-session-discarded',
          status: 'fail',
          detail:
            facts.discardedSessions.length +
            ' pty_kill with cleanup: true, which removes the session and its buffer; the human keeps those',
        }
  )

  const finished = !facts.timedOut && facts.errors.length === 0
  checks.push(
    finished
      ? { name: 'run-finished', status: 'pass', detail: 'no timeout, no error event' }
      : {
          name: 'run-finished',
          status: 'fail',
          detail: facts.timedOut
            ? 'the run hit the wall-clock timeout and was killed'
            : `error events: ${facts.errors.join(' | ')}`,
        }
  )

  // The promise the read budget exists to keep: a result never tells the model
  // the data is finished and, in the same breath, that it was cut.
  checks.push(
    facts.contradictoryResult
      ? {
          name: 'no-result-contradicts-itself',
          status: 'fail',
          detail: 'a result said truncated="true" and "End of buffer" at once',
        }
      : {
          name: 'no-result-contradicts-itself',
          status: 'pass',
          detail: `${options.resultCount} result(s), none both cut and finished`,
        }
  )

  const required = scenario.answerMustContain(token)
  const forbidden = scenario.answerMustNotContain(token)
  const missing = required.filter((needle) => !facts.answer.includes(needle))
  const present = forbidden.filter((needle) => facts.answer.includes(needle))
  // Where the case seeded a random token, it has to have reached the model
  // through a pty tool. A case that leaves the shell tool in reach can be
  // answered by reading the fixture's *source*, which proves nothing.
  // Where the case seeded a random token, a PTY has to have produced it. Read
  // from the plugin's archive rather than the transcript, because a case that
  // leaves the shell tool in reach can be answered by reading the fixture's
  // *source*, which proves nothing about the tools.
  const seeded = required.some((needle) => needle.includes(token))
  // Either piece of evidence is enough: the archive proves a session printed
  // it, and a pty tool result proves the model was shown it. A model that
  // discards the session afterwards takes the archive with it, and that is a
  // separate anti-pattern with its own check, not a reason to doubt the token.
  const produced =
    !seeded || options.producedOutput.includes(token) || facts.ptyToolOutput.includes(token)
  const sawIt = !seeded || facts.ptyToolOutput.includes(token)
  if (missing.length === 0 && present.length === 0 && produced) {
    checks.push({
      name: 'answer-is-right',
      status: 'pass',
      detail:
        `the answer contains ${required.join(', ') || '(nothing required)'}` +
        (seeded ? ', and a pty session printed it' : ''),
    })
    if (seeded) {
      checks.push(
        sawIt
          ? {
              name: 'saw-it-in-a-pty-result',
              status: 'pass',
              detail: 'the token came back through a pty tool result, not from the fixture source',
            }
          : {
              name: 'saw-it-in-a-pty-result',
              status: 'skip',
              detail:
                'a pty session printed it, but the model reported it without reading it back ' +
                'through a pty tool - it read the fixture source with the shell tool instead',
              advisory: true,
            }
      )
    }
  } else if (!produced) {
    checks.push({
      name: 'answer-is-right',
      status: 'fail',
      detail: 'the token appears in the answer but no pty session ever printed it',
    })
  } else {
    const problems = [
      missing.length > 0 ? `missing ${missing.join(', ')}` : '',
      present.length > 0 ? `must not contain ${present.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('; ')
    checks.push({ name: 'answer-is-right', status: 'fail', detail: problems })
  }

  return checks
}

export function evaluateRun(options: {
  scenario: Scenario
  token: string
  transcript: Transcript
  pluginLoaded: boolean
  timedOut: boolean
  durationMs: number
  exitCode: number | null
  model: string
  warnings: string[]
  workspaceRoot: string
  /** What the PTY sessions in this workspace printed, from the plugin's archive. */
  producedOutput?: string
}): ScenarioOutcome {
  const facts = buildFacts(options.transcript, {
    pluginLoaded: options.pluginLoaded,
    timedOut: options.timedOut,
  })
  const checks = [
    ...genericChecks({
      scenario: options.scenario,
      token: options.token,
      facts,
      resultCount: options.transcript.toolCalls.length,
      producedOutput: options.producedOutput ?? '',
    }),
  ]
  for (const check of options.scenario.checks?.(facts) ?? []) checks.push(check)

  const failures = checks.filter((check) => check.status === 'fail')
  // A skip means the case never got to test what it exists to test, which is not
  // a pass. An advisory check is measured rather than gated, so it is reported
  // without demoting the case for behaviour the tool deliberately allows.
  const blocking = checks.filter((check) => check.status === 'skip' && check.advisory !== true)
  const status: ScenarioOutcome['status'] =
    failures.length > 0 ? 'fail' : blocking.length > 0 ? 'inconclusive' : 'pass'

  const usage = totalUsage(options.transcript)
  return {
    scenarioId: options.scenario.id,
    title: options.scenario.title,
    model: options.model,
    token: options.token,
    status,
    checks,
    facts,
    metrics: {
      durationMs: options.durationMs,
      model: options.model,
      inputTokens: usage.input,
      outputTokens: usage.output,
      reasoningTokens: usage.reasoning,
      cacheReadTokens: usage.cacheRead,
      cost: usage.cost,
      steps: options.transcript.steps.length,
      ptyToolCalls: facts.calls.length,
      hostToolCalls: options.transcript.toolCalls.length,
      shellCommands: facts.shellCommands.length,
      exitCode: options.exitCode,
      timedOut: options.timedOut,
    },
    answer: facts.answer,
    warnings: options.warnings,
    workspaceRoot: options.workspaceRoot,
  }
}
