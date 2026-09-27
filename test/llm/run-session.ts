/**
 * Run one isolated opencode session and collect what the model did.
 *
 * Self-termination is the whole point of this file. A model that decides to keep
 * going must not be able to spend money after the harness has given up, so the
 * child is started in its own process group and the group is killed on timeout:
 * the CLI, the `opencode serve` it spawns, and every PTY session underneath it.
 */

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseEventStream, type RawEvent, type Transcript } from './events.ts'
import { HARNESS_AGENT, OPENCODE_BINARY, type Workspace } from './workspace.ts'

export const DEFAULT_TIMEOUT_MS = 240_000
/** Extra grace before SIGKILL after SIGTERM. */
const TERM_GRACE_MS = 5_000

export interface RunSessionOptions {
  workspace: Workspace
  env: Record<string, string>
  model: string
  prompt: string
  timeoutMs?: number
  /**
   * Host binary to run. Defaults to `OPENCODE_BINARY` or `opencode` on PATH;
   * overridable so the timeout path can be tested without a real host.
   */
  binary?: string
  /**
   * Directory to keep the raw stream in after the workspace is removed.
   *
   * A red run costs money to reproduce, so the transcript has to outlive the
   * temp directory. Off by default: the stream is the whole conversation,
   * including the prompt, and where that should land is the caller's decision.
   */
  artifacts?: string
}

export interface SessionResult {
  transcript: Transcript
  /** Raw NDJSON, so a failure can be read without re-running. */
  rawStdout: string
  rawStderr: string
  exitCode: number | null
  signal: NodeJS.Signals | null
  durationMs: number
  timedOut: boolean
  /** Model the run was actually asked to use. */
  model: string
}

export function sessionArgs(options: RunSessionOptions): string[] {
  return [
    'run',
    '--format=json',
    '--standalone',
    '--auto',
    '--agent',
    HARNESS_AGENT,
    '--model',
    options.model,
    options.prompt,
  ]
}

function killGroup(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return
  try {
    // Negative pid targets the process group, which the child leads because it
    // was spawned detached. That is what takes the PTY sessions with it.
    process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // Already gone.
    }
  }
}

export async function runSession(options: RunSessionOptions): Promise<SessionResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const started = performance.now()
  const child = spawn(options.binary ?? OPENCODE_BINARY, sessionArgs(options), {
    cwd: options.workspace.projectDir,
    env: options.env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk
  })
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk
  })

  let timedOut = false
  const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      const timer = setTimeout(() => {
        timedOut = true
        killGroup(child, 'SIGTERM')
        setTimeout(() => killGroup(child, 'SIGKILL'), TERM_GRACE_MS).unref()
      }, timeoutMs)
      child.once('close', (code, signal) => {
        clearTimeout(timer)
        resolve({ code, signal })
      })
      child.once('error', (error) => {
        clearTimeout(timer)
        stderr += `\nspawn failed: ${error instanceof Error ? error.message : String(error)}\n`
        resolve({ code: null, signal: null })
      })
    }
  )

  const durationMs = performance.now() - started
  persistArtifacts(options.workspace, stdout, stderr, options.artifacts)
  return {
    transcript: parseEventStream(stdout),
    rawStdout: stdout,
    rawStderr: stderr,
    exitCode: outcome.code,
    signal: outcome.signal,
    durationMs,
    timedOut,
    model: options.model,
  }
}

/**
 * Keep the raw stream beside the workspace, and optionally beyond it.
 *
 * A red scenario that has to be re-run to be read costs tokens; a log that
 * survives costs nothing. The workspace copy goes when the workspace does; the
 * artifact copy is only written when the caller asked for a place to put it.
 */
function persistArtifacts(
  workspace: Workspace,
  stdout: string,
  stderr: string,
  artifacts: string | undefined
): void {
  try {
    writeFileSync(join(workspace.root, 'run.ndjson'), stdout)
    writeFileSync(join(workspace.root, 'run.err'), stderr)
  } catch {
    // The workspace may already have been removed; that is fine.
  }
  if (artifacts === undefined) return
  try {
    mkdirSync(artifacts, { recursive: true })
    const stamp = `${workspace.root.split('/').pop() ?? 'run'}`
    writeFileSync(join(artifacts, `${stamp}.ndjson`), stdout)
    writeFileSync(join(artifacts, `${stamp}.err`), stderr)
  } catch {
    // Losing the artefact must never fail a run that already finished.
  }
}

/** Stream events as they arrive, for the runner's live progress output. */
export function partialTranscript(raw: string): Transcript {
  return parseEventStream(raw)
}

export type { RawEvent }
