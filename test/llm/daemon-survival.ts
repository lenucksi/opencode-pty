/**
 * The daemon half of the LLM harness: does a PTY outlive the opencode that started it?
 *
 * The scenario runner in `run.ts` is one host, one prompt, one verdict. Survival is the
 * opposite shape - two hosts in sequence, with the process group of the first one killed
 * in between - so it lives here rather than as a `Scenario`.
 *
 * This file holds the decisions and the paths, so they are testable without a model or a
 * host. `daemon-survival-run.ts` is the driver that spends tokens; it imports everything
 * here and adds nothing but sequencing.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Transcript } from './events.ts'
import { isPtyToolName } from './pty-calls.ts'

/** Where the daemon keeps its socket, its pid and the archive it owns. */
export interface DaemonPaths {
  socket: string
  pidFile: string
  stateDir: string
}

/**
 * Resolve the daemon's paths from the same environment the plugin sees.
 *
 * Mirrors `PtyClient` and `sessionsRoot()` rather than importing them: a test that
 * derives the path through the code under test cannot notice that both sides moved
 * together and are now wrong.
 */
export function daemonPaths(env: Record<string, string | undefined>): DaemonPaths {
  const runtime = env.XDG_RUNTIME_DIR ?? '/tmp'
  const stateHome = env.XDG_STATE_HOME ?? env.HOME?.concat('/.local/state') ?? '/tmp'
  return {
    socket: join(runtime, 'opencode-pty', 'ptyd.sock'),
    pidFile: join(runtime, 'opencode-pty', 'ptyd.pid'),
    stateDir: env.OPENCODE_PTY_STATE_DIR ?? join(stateHome, 'opencode', 'opencode-pty', 'sessions'),
  }
}

/** The pid the daemon wrote, or null when the file is missing or not a number. */
export function readPid(pidFile: string): number | null {
  if (!existsSync(pidFile)) return null
  const parsed = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

/**
 * Whether `pid` is still running.
 *
 * Signal 0 does the permission check and delivers nothing, which is the only portable
 * liveness probe that does not disturb the process.
 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Session directories whose `output.log` contains the token.
 *
 * The archive is the authority, not the transcript: a model can repeat a token it read
 * in the prompt without a PTY ever having printed it.
 */
export function archivedSessionsWithToken(stateDir: string, token: string): string[] {
  const roots = [stateDir, join(stateDir, 'sessions')].filter((root) => existsSync(root))
  const found: string[] = []
  for (const root of roots) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const directory = join(root, entry.name)
      let names: string[]
      try {
        names = readdirSync(directory)
      } catch {
        continue
      }
      for (const name of names) {
        if (!name.startsWith('output.log')) continue
        try {
          if (readFileSync(join(directory, name), 'utf8').includes(token)) {
            found.push(entry.name)
            break
          }
        } catch {
          // A rotated log that vanished mid-read is not a survival failure.
        }
      }
    }
  }
  return found
}

/** Everything Phase A has to prove, in the order a reader would check it. */
export interface PhaseAInput {
  token: string
  transcript: Transcript
  socketExists: boolean
  pid: number | null
  pidAlive: boolean
  archivedIds: readonly string[]
}

export interface Verdict {
  ok: boolean
  reasons: string[]
  /** The session the daemon still owns, when exactly one printed the token. */
  sessionId: string | null
}

export function evaluatePhaseA(input: PhaseAInput): Verdict {
  const reasons: string[] = []
  if (!input.socketExists) reasons.push('the daemon socket does not exist after the first run')
  if (input.pid === null) reasons.push('the daemon pid file is missing or unreadable')
  else if (!input.pidAlive) reasons.push(`the daemon pid ${input.pid} is not running`)
  if (!calledPtyTool(input.transcript, 'pty_spawn'))
    reasons.push('the model never called pty_spawn')
  if (input.archivedIds.length === 0)
    reasons.push('no archived session printed the token, so no PTY ran')
  else if (input.archivedIds.length > 1)
    reasons.push(`${input.archivedIds.length} sessions printed the token; expected one`)
  return {
    ok: reasons.length === 0,
    reasons,
    sessionId: input.archivedIds.length === 1 ? (input.archivedIds[0] ?? null) : null,
  }
}

/** What Phase B has to prove: the same session, from a host that never started it. */
export interface PhaseBInput {
  token: string
  transcript: Transcript
  expectedSessionId: string | null
  pidAlive: boolean
}

export function evaluatePhaseB(input: PhaseBInput): Verdict {
  const reasons: string[] = []
  if (!input.pidAlive) reasons.push('the daemon died while the second host ran')
  if (!calledPtyTool(input.transcript, 'pty_list'))
    reasons.push('the second host never called pty_list')
  const output = toolOutput(input.transcript)
  if (input.expectedSessionId === null) {
    reasons.push('the first phase produced no session id to look for')
  } else if (!output.includes(input.expectedSessionId)) {
    reasons.push(`the session id ${input.expectedSessionId} does not appear in the second run`)
  }
  if (!output.includes('running')) {
    reasons.push('the second run never reported a session as running')
  }
  if (!output.includes(input.token)) {
    reasons.push('the second run never read the token back out of the buffer')
  }
  return { ok: reasons.length === 0, reasons, sessionId: input.expectedSessionId }
}

function calledPtyTool(transcript: Transcript, name: string): boolean {
  return transcript.toolCalls.some(
    (call) => call.tool === name || call.input.includes(`.${name}(`) || call.input.includes(name)
  )
}

function toolOutput(transcript: Transcript): string {
  return transcript.toolCalls.map((call) => call.output).join('\n')
}

/** Whether any PTY tool was reached at all - useful in a failure message. */
export function ptyToolNamesUsed(transcript: Transcript): string[] {
  const names = new Set<string>()
  for (const call of transcript.toolCalls) {
    if (isPtyToolName(call.tool)) names.add(call.tool)
    for (const name of ['pty_spawn', 'pty_list', 'pty_read', 'pty_kill', 'pty_wait'] as const) {
      if (call.input.includes(`.${name}(`)) names.add(name)
    }
  }
  return [...names].sort()
}

/**
 * The prompt for the first host.
 *
 * Deliberately explicit about the sleep: a session that exits leaves nothing to survive,
 * and a model that "helpfully" kills it proves nothing.
 */
export function phaseAPrompt(token: string): string {
  return [
    'Start exactly one background PTY session and do not kill it afterwards.',
    `Use pty_spawn with command "sh" and args ["-c", "echo ${token}; sleep 300"].`,
    'Give it the description "daemon survival probe".',
    'Wait until its output contains the token, then report the session id.',
    'Do not call pty_kill.',
  ].join(' ')
}

/**
 * The prompt for the second host.
 *
 * It asks for evidence, not for a claim: the verdict reads the tool output, so a model
 * that merely says "it survived" still fails when nothing was listed or read.
 */
export function phaseBPrompt(token: string): string {
  return [
    'A PTY session started by another opencode instance should still be running.',
    `Call pty_list, then read the output of the session that printed the token ${token}.`,
    'Report the session id, its status, and whether its output contains the token.',
    'Do not kill anything.',
  ].join(' ')
}

export interface SurvivalArgs {
  dryRun: boolean
  keep: boolean
  model: string
  timeoutMs: number
  artifacts: string
  help: boolean
}

export function parseSurvivalArgs(argv: readonly string[]): SurvivalArgs {
  const args: SurvivalArgs = {
    dryRun: false,
    keep: false,
    model: '',
    timeoutMs: 240_000,
    artifacts: '',
    help: false,
  }
  for (const arg of argv) {
    if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--keep') args.keep = true
    else if (arg === '--help' || arg === '-h') args.help = true
    else if (arg.startsWith('--model=')) args.model = arg.slice('--model='.length)
    else if (arg.startsWith('--timeout=')) {
      const parsed = Number.parseInt(arg.slice('--timeout='.length), 10)
      if (Number.isSafeInteger(parsed) && parsed > 0) args.timeoutMs = parsed * 1000
    } else if (arg.startsWith('--artifacts=')) args.artifacts = arg.slice('--artifacts='.length)
    else throw new Error(`unknown flag ${arg}. Run with --help.`)
  }
  return args
}

export function survivalUsage(): string {
  return [
    'Usage: bun test/llm/daemon-survival-run.ts [flags]',
    '',
    '  --dry-run         no model and no tokens: drive the daemon through PtyClient directly',
    '  --keep            keep the throwaway workspace for inspection',
    '  --model=<p/m>     model id; then $PTY_LLM_HARNESS_MODEL; then the harness default',
    '  --timeout=<s>     per-run wall clock, in seconds (default 240)',
    '  --artifacts=DIR   keep the raw NDJSON there after the workspace is removed',
    '',
  ].join('\n')
}
