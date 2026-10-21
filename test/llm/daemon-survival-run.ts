#!/usr/bin/env bun
/**
 * Two opencode hosts, one daemon: does a PTY survive the host that started it?
 *
 * Phase A asks a real model to spawn a long-lived session; the host exits and its whole
 * process group is killed. Phase B starts a fresh host with the same environment and has
 * it list and read that session. A pass means the daemon owned the PTY, not the host.
 *
 * `--dry-run` proves the same property without a model: two `PtyClient` connections in
 * sequence, the first one gone before the second looks. That is the cheap regression
 * check for the auto-start path.
 *
 * Both paths are isolated: their own XDG data/config/state/runtime directories, so the
 * host's database, socket and archive are never touched.
 */

import { existsSync } from 'node:fs'

import { PtyClient } from '../../src/client/pty-client.ts'
import {
  archivedSessionsWithToken,
  type DaemonPaths,
  daemonPaths,
  evaluatePhaseA,
  evaluatePhaseB,
  isAlive,
  parseSurvivalArgs,
  phaseAPrompt,
  phaseBPrompt,
  ptyToolNamesUsed,
  readPid,
  survivalUsage,
} from './daemon-survival.ts'
import type { parseEventStream } from './events.ts'
import { resolveModel } from './run.ts'
import { runSession } from './run-session.ts'
import {
  bootstrapCredentials,
  buildHarnessConfig,
  buildRunEnv,
  createWorkspace,
  pluginDidLoad,
  type Workspace,
  writeHarnessConfig,
} from './workspace.ts'

const write = (text: string): void => {
  process.stdout.write(text)
}

export const DRY_RUN_TOKEN = 'daemon-dry-run-token'

export function dryRunPrompt(): { command: string; args: string[]; description: string } {
  return {
    command: 'sh',
    args: ['-c', `echo ${DRY_RUN_TOKEN}; sleep 120`],
    description: 'daemon survival dry run',
  }
}

function probe(paths: DaemonPaths, token: string) {
  const pid = readPid(paths.pidFile)
  return {
    socketExists: existsSync(paths.socket),
    pid,
    pidAlive: pid !== null && isAlive(pid),
    archivedIds: archivedSessionsWithToken(paths.stateDir, token),
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function waitForToken(
  client: PtyClient,
  id: string,
  token: string,
  attempts = 40
): Promise<string | null> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await client.read(id, 0, 50)
    const text = result?.lines?.join('\n') ?? ''
    if (text.includes(token)) return text
    await Bun.sleep(75)
  }
  return null
}

function stopDaemon(paths: DaemonPaths): void {
  const pid = readPid(paths.pidFile)
  if (pid === null) return
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    // Already gone.
  }
}

/**
 * The no-model half: two clients, one daemon, and a session that has to outlive the first
 * client. Returns the process exit code so the driver stays a thin wrapper.
 */
export async function runDry(workspace: Workspace, env: Record<string, string>): Promise<number> {
  const paths = daemonPaths(env)
  const failures: string[] = []
  let sessionId: string | null = null

  const first = new PtyClient({ socketPath: paths.socket, stateDir: workspace.ptyStateDir })
  try {
    await first.connect()
    const pong = await first.ping()
    write(`- daemon answer: ${pong.pong ? 'pong' : 'no pong'}\n`)
    if (!pong.pong) failures.push('the daemon did not answer ping')

    const probeInfo = probe(paths, DRY_RUN_TOKEN)
    if (!probeInfo.socketExists) failures.push('the auto-started daemon left no socket')
    if (probeInfo.pid === null) failures.push('the auto-started daemon left no pid file')
    else if (!probeInfo.pidAlive) failures.push(`daemon pid ${probeInfo.pid} is not running`)

    const spawned = await first.spawn(dryRunPrompt())
    sessionId = spawned.id
    write(`- spawned ${spawned.id}\n`)

    const output = await waitForToken(first, spawned.id, DRY_RUN_TOKEN)
    if (output === null) failures.push('the session never printed the token')
    else write('- the session printed the token\n')

    // No kill here: a session that is cleaned up cannot prove it survived.
  } catch (error) {
    failures.push(`first client failed: ${describe(error)}`)
  } finally {
    first.disconnect()
  }

  // The first client is gone. Give the daemon a moment, then look with a fresh one.
  await Bun.sleep(300)
  const afterDisconnect = probe(paths, DRY_RUN_TOKEN)
  if (!afterDisconnect.pidAlive) failures.push('the daemon died when the first client left')

  const second = new PtyClient({ socketPath: paths.socket, stateDir: workspace.ptyStateDir })
  try {
    await second.connect()
    const sessions = await second.list()
    const found = (sessions as Array<{ id?: string; status?: string }>).find(
      (session) => session.id === sessionId
    )
    if (found === undefined) failures.push('the second client does not list the session')
    else if (found.status !== 'running')
      failures.push(`the session is '${String(found.status)}' in the second client, not running`)
    else write(`- the second client sees ${String(found.id)} running\n`)

    if (sessionId !== null) {
      const reread = await waitForToken(second, sessionId, DRY_RUN_TOKEN, 10)
      if (reread === null) failures.push('the second client could not read the token back')
      else write('- the second client read the token back out of the buffer\n')
      await second.kill(sessionId, true)
    }
  } catch (error) {
    failures.push(`second client failed: ${describe(error)}`)
  } finally {
    second.disconnect()
  }

  stopDaemon(paths)

  if (failures.length === 0) {
    write('\nDRY RUN PASS - the daemon outlived its first client and the session stayed up.\n')
    return 0
  }
  write(`\nDRY RUN FAIL\n${failures.map((reason) => `  - ${reason}`).join('\n')}\n`)
  return 1
}

interface PhaseResult {
  transcript: ReturnType<typeof parseEventStream>
  stdout: string
  stderr: string
}

async function runPhase(
  workspace: Workspace,
  env: Record<string, string>,
  model: string,
  prompt: string,
  timeoutMs: number,
  artifacts: string
): Promise<PhaseResult> {
  const session = await runSession({
    workspace,
    env,
    model,
    prompt,
    timeoutMs,
    ...(artifacts === '' ? {} : { artifacts }),
  })
  return {
    transcript: session.transcript,
    stdout: session.rawStdout,
    stderr: session.rawStderr,
  }
}

export async function runLive(
  workspace: Workspace,
  env: Record<string, string>,
  model: string,
  timeoutMs: number,
  artifacts: string
): Promise<number> {
  const token = `survive-${Math.random().toString(36).slice(2, 10)}`
  const paths = daemonPaths(env)

  write(`- workspace: ${workspace.root}\n- model: ${model}\n- token: ${token}\n\n`)

  write('--- phase A: a host spawns a long-lived session, then exits\n')
  const phaseA = await runPhase(
    workspace,
    env,
    model,
    phaseAPrompt(token),
    timeoutMs,
    artifacts === '' ? '' : `${artifacts}/phase-a.ndjson`
  )
  const afterA = probe(paths, token)
  const verdictA = evaluatePhaseA({
    token,
    transcript: phaseA.transcript,
    socketExists: afterA.socketExists,
    pid: afterA.pid,
    pidAlive: afterA.pidAlive,
    archivedIds: afterA.archivedIds,
  })
  write(
    `- pty tools: ${ptyToolNamesUsed(phaseA.transcript).join(', ') || 'none'}\n` +
      `- daemon: socket=${afterA.socketExists} pid=${String(afterA.pid)} alive=${afterA.pidAlive}\n` +
      `- archived sessions with the token: ${afterA.archivedIds.join(', ') || 'none'}\n` +
      `- phase A: ${verdictA.ok ? 'PASS' : 'FAIL'}\n`
  )
  for (const reason of verdictA.reasons) write(`    ${reason}\n`)
  if (!verdictA.ok) {
    if (phaseA.stderr.trim() !== '') write(`    stderr: ${phaseA.stderr.trim().slice(-800)}\n`)
    stopDaemon(paths)
    return 1
  }

  write('\n--- phase B: a new host lists and reads it\n')
  const phaseB = await runPhase(
    workspace,
    env,
    model,
    phaseBPrompt(token),
    timeoutMs,
    artifacts === '' ? '' : `${artifacts}/phase-b.ndjson`
  )
  const afterB = probe(paths, token)
  const verdictB = evaluatePhaseB({
    token,
    transcript: phaseB.transcript,
    expectedSessionId: verdictA.sessionId,
    pidAlive: afterB.pidAlive,
  })
  write(
    `- pty tools: ${ptyToolNamesUsed(phaseB.transcript).join(', ') || 'none'}\n` +
      `- daemon alive: ${afterB.pidAlive}\n` +
      `- phase B: ${verdictB.ok ? 'PASS' : 'FAIL'}\n`
  )
  for (const reason of verdictB.reasons) write(`    ${reason}\n`)
  if (!verdictB.ok && phaseB.stderr.trim() !== '')
    write(`    stderr: ${phaseB.stderr.trim().slice(-800)}\n`)

  stopDaemon(paths)
  return verdictB.ok ? 0 : 1
}

async function main(argv: readonly string[]): Promise<number> {
  let args: ReturnType<typeof parseSurvivalArgs>
  try {
    args = parseSurvivalArgs(argv)
  } catch (error) {
    write(`${describe(error)}\n`)
    return 2
  }
  if (args.help) {
    write(survivalUsage())
    return 0
  }

  const workspace = createWorkspace({ keep: args.keep, label: 'daemon-survival' })
  try {
    const env = buildRunEnv({ workspace })
    // The only switch the daemon needs: the plugin reads this before it decides whether
    // to connect at all, and it leaves the config shape alone.
    env.PTY_DAEMON = '1'

    if (args.dryRun) {
      write(`workspace: ${workspace.root}\nmodel: (dry run, none)\n\n`)
      return await runDry(workspace, env)
    }

    const model = resolveModel(args.model === '' ? undefined : args.model, process.env)
    writeHarnessConfig(
      workspace,
      buildHarnessConfig({
        pluginDir: `${workspace.root}/plugin`,
        model,
        disabledTools: [],
      })
    )
    const copied = bootstrapCredentials(workspace, env)
    write(`- credentials copied: ${String(copied)}\n`)
    if (!pluginDidLoad(workspace)) {
      // Not fatal on its own: the plugin logs on setup, and a host that never started it
      // fails every phase below with a clearer reason than this one.
      write('- warning: no plugin load marker in the PTY log yet\n')
    }
    return await runLive(workspace, env, model, args.timeoutMs, args.artifacts)
  } finally {
    if (args.keep) write(`- workspace kept: ${workspace.root}\n`)
    workspace.cleanup()
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)))
}
