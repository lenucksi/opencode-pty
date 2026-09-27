/**
 * LLM-in-the-loop harness for the model-facing half of opencode-pty.
 *
 *   bun run test:llm                     # every case once
 *   bun run test:llm -- --scenario=truncation-resume
 *   bun run test:llm -- --repeat=3 --model anthropic/claude-haiku-4-5
 *
 * What it does: builds a throwaway opencode installation, points it at the
 * locally built plugin, asks a real model one question per case, and asserts
 * what the model *did* - which tools it called, with which arguments, and
 * whether its answer contains a token that only exists past the point a
 * truncated read stops.
 *
 * The model is resolved from `--model`, then `PTY_LLM_HARNESS_MODEL`, then
 * `opencode-go/space-bunny-free`. Behaviour is model dependent: the assertions
 * are about documentation the model has to follow, and a different model will
 * follow it differently. Every result line names the model, so a behaviour
 * change is distinguishable from a regression in the plugin.
 *
 * Cost matters. Every run is a real model call. `--list` prints the cases
 * without spending anything, and nothing here runs as part of `test:local`.
 */

import { evaluateRun, type ScenarioOutcome } from './evaluate.ts'
import { formatOutcome, formatScenarioList, formatSummary } from './report.ts'
import { DEFAULT_TIMEOUT_MS, runSession, type SessionResult } from './run-session.ts'
import { disabledToolsFor, findScenario, newToken, SCENARIOS, type Scenario } from './scenarios.ts'
import {
  bootstrapCredentials,
  buildHarnessConfig,
  buildRunEnv,
  createWorkspace,
  findRepoRoot,
  pluginDidLoad,
  pluginLoadWarnings,
  readArchivedOutput,
  type Workspace,
  writeHarnessConfig,
} from './workspace.ts'

export const MODEL_ENV = 'PTY_LLM_HARNESS_MODEL'
export const DEFAULT_MODEL = 'opencode-go/space-bunny-free'

export interface RunnerOptions {
  scenarioIds: string[]
  repeat: number
  model: string
  timeoutMs: number
  keep: boolean
  list: boolean
  /** Directory to keep raw transcripts in; empty means do not keep them. */
  artifacts: string
  /**
   * Host binary to run. Defaults to `OPENCODE_BINARY` or `opencode` on PATH.
   * Overridable so the whole pipeline can be exercised without a real host.
   */
  binary?: string
}

/**
 * `--model` wins, then the environment, then the default.
 *
 * Kept as a pure function so the resolution order is testable without spending
 * a token.
 */
export function resolveModel(flag: string | undefined, env: NodeJS.ProcessEnv): string {
  const fromFlag = flag?.trim()
  if (fromFlag !== undefined && fromFlag !== '') return fromFlag
  const fromEnv = env[MODEL_ENV]?.trim()
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  return DEFAULT_MODEL
}

export function usage(): string {
  return [
    'Usage: bun run test:llm [--options]',
    '',
    '  --scenario=ID   run one case (repeatable); default: every case',
    '  --repeat=N      run each case N times, to measure flakiness (default 1)',
    '  --model=PROV/M  override the model for this run',
    '  --timeout=SEC   hard wall-clock limit per run (default 240)',
    '  --keep          keep the throwaway workspace for inspection',
    '  --artifacts=DIR also keep the raw transcript here, after the workspace is gone',
    '  --list          print the cases and exit without spending anything',
    '',
    `Model resolution: --model, then $${MODEL_ENV}, then ${DEFAULT_MODEL}.`,
    '',
  ].join('\n')
}

export function parseArgs(argv: readonly string[]): RunnerOptions {
  const options: RunnerOptions = {
    scenarioIds: [],
    repeat: 1,
    model: '',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    keep: false,
    list: false,
    artifacts: '',
  }
  for (const arg of argv) {
    const [key, value = ''] = arg.replace(/^--/, '').split('=')
    switch (key) {
      case 'scenario':
      case 's':
        options.scenarioIds.push(value)
        break
      case 'repeat':
      case 'n':
        options.repeat = Math.max(1, Number.parseInt(value, 10) || 1)
        break
      case 'model':
      case 'm':
        options.model = value
        break
      case 'timeout':
        options.timeoutMs = Math.max(10_000, (Number.parseInt(value, 10) || 0) * 1000)
        break
      case 'keep':
        options.keep = true
        break
      case 'artifacts':
        options.artifacts = value
        break
      case 'list':
      case 'l':
        options.list = true
        break
      case 'help':
      case 'h':
        process.stdout.write(usage())
        process.exit(0)
        break
      default:
        throw new Error(`unknown flag --${key}. Run with --help.`)
    }
  }
  return options
}

export function selectScenarios(ids: readonly string[]): Scenario[] {
  if (ids.length === 0) return [...SCENARIOS]
  return ids.map((id) => {
    const found = findScenario(id)
    if (found === undefined) {
      throw new Error(`unknown scenario '${id}'. Known: ${SCENARIOS.map((s) => s.id).join(', ')}`)
    }
    return found
  })
}

export interface RunOnceResult {
  outcome: ScenarioOutcome
  session: SessionResult
  workspace: Workspace
}

/**
 * One scenario, one isolated host, one real model call.
 *
 * The workspace is removed in a `finally`, so a throw halfway through cannot
 * leave a temp directory or a live PTY behind.
 */
export async function runOnce(
  scenario: Scenario,
  options: RunnerOptions,
  model: string,
  repoRoot: string
): Promise<RunOnceResult> {
  const token = newToken()
  const workspace = createWorkspace({ repoRoot, keep: options.keep, label: scenario.id })
  try {
    const context = {
      projectDir: workspace.projectDir,
      env: {} as Record<string, string>,
      disabledTools: disabledToolsFor(scenario),
    }
    scenario.prepare(context, token)

    const env = buildRunEnv({ workspace })
    for (const [key, value] of Object.entries(context.env)) env[key] = value

    writeHarnessConfig(
      workspace,
      buildHarnessConfig({
        pluginDir: `${workspace.root}/plugin`,
        model,
        disabledTools: context.disabledTools,
      })
    )

    bootstrapCredentials(workspace, env, options.binary)

    const session = await runSession({
      workspace,
      env,
      model,
      prompt: scenario.prompt(token),
      timeoutMs: options.timeoutMs,
      ...(options.binary === undefined ? {} : { binary: options.binary }),
      ...(options.artifacts === '' ? {} : { artifacts: options.artifacts }),
    })

    const warnings = [
      ...workspace.warnings,
      ...pluginLoadWarnings(workspace).map((line) => `host: ${line}`),
    ]
    const outcome = evaluateRun({
      scenario,
      token,
      transcript: session.transcript,
      pluginLoaded: pluginDidLoad(workspace),
      timedOut: session.timedOut,
      durationMs: session.durationMs,
      exitCode: session.exitCode,
      model,
      warnings,
      workspaceRoot: workspace.root,
      producedOutput: readArchivedOutput(workspace.ptyStateDir),
    })
    return { outcome, session, workspace }
  } finally {
    workspace.cleanup()
  }
}

export type Execute = typeof runOnce

export interface MainOptions {
  argv: readonly string[]
  env?: NodeJS.ProcessEnv
  /** Replaced in tests; the real thing spends tokens. */
  execute?: Execute
  write?: (text: string) => void
  repoRoot?: string
}

export async function main(options: MainOptions): Promise<number> {
  const write = options.write ?? ((text: string) => process.stdout.write(text))
  const env = options.env ?? process.env
  const execute = options.execute ?? runOnce
  const repoRoot = options.repoRoot ?? findRepoRoot()

  let parsed: RunnerOptions
  try {
    parsed = parseArgs(options.argv)
  } catch (error) {
    write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }

  if (parsed.list) {
    write(formatScenarioList(SCENARIOS))
    return 0
  }

  const model = resolveModel(parsed.model === '' ? undefined : parsed.model, env)
  const scenarios = selectScenarios(parsed.scenarioIds)

  write(
    `model: ${model}\ncases: ${scenarios.map((scenario) => scenario.id).join(', ')}\n` +
      `repeat: ${parsed.repeat}  timeout: ${parsed.timeoutMs / 1000}s\n\n` +
      'command: opencode run --format=json --standalone --auto --agent pty-harness --model ' +
      `${model} "<prompt>"\n\n`
  )

  const outcomes: ScenarioOutcome[] = []
  for (const scenario of scenarios) {
    for (let attempt = 1; attempt <= parsed.repeat; attempt += 1) {
      write(`--- ${scenario.id} run ${attempt}/${parsed.repeat}\n`)
      const { outcome } = await execute(scenario, parsed, model, repoRoot)
      outcomes.push(outcome)
      write(`${formatOutcome(outcome)}\n\n`)
    }
  }

  write(`${formatSummary(outcomes)}\n`)
  return outcomes.every((outcome) => outcome.status === 'pass') ? 0 : 1
}

if (import.meta.main) {
  process.exit(await main({ argv: process.argv.slice(2) }))
}
