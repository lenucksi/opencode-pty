export type EnvironmentOverrides = Record<string, string | undefined>

export interface CapturedCommand {
  exitCode: number
  stdout: string
  stderr: string
}

export interface RunOptions {
  /** Extra environment for the child, merged over the current process env. */
  env?: EnvironmentOverrides
  /** Milliseconds before the child is killed and the run fails. 0 disables it. */
  timeoutMs?: number
}

export class CommandFailure extends Error {
  public readonly command: string
  public readonly exitCode: number
  public readonly stderr: string

  public constructor(command: string, exitCode: number, stderr: string) {
    super(`${command} exited with code ${exitCode}`)
    this.name = 'CommandFailure'
    this.command = command
    this.exitCode = exitCode
    this.stderr = stderr.trim()
  }
}

export class CommandTimeout extends Error {
  public readonly command: string
  public readonly timeoutMs: number

  public constructor(command: string, timeoutMs: number) {
    super(`${command} timed out after ${Math.round(timeoutMs / 1000)}s`)
    this.name = 'CommandTimeout'
    this.command = command
    this.timeoutMs = timeoutMs
  }
}

function spawnEnvironment(overrides?: EnvironmentOverrides): Record<string, string | undefined> {
  return { ...process.env, ...overrides }
}

function commandText(command: string, args: string[]): string {
  return [command, ...args].join(' ')
}

interface KillableProcess {
  exited: Promise<number>
  kill: (signal?: number | NodeJS.Signals) => void
}

/**
 * Wait for a child, killing it if it overruns.
 *
 * Without this a single hanging step - a network scan that never answers - blocks
 * the whole gate with no way out, which is worse than a reported failure.
 */
async function awaitExit(
  processHandle: KillableProcess,
  command: string,
  timeoutMs: number
): Promise<number> {
  if (timeoutMs <= 0) {
    return await processHandle.exited
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<never>((_, rejectPromise) => {
    timer = setTimeout(() => {
      processHandle.kill('SIGKILL')
      rejectPromise(new CommandTimeout(command, timeoutMs))
    }, timeoutMs)
  })
  try {
    return await Promise.race([processHandle.exited, expiry])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export async function runInherited(
  command: string,
  args: string[],
  options?: RunOptions
): Promise<void> {
  const { timeoutMs = 0, env } = options ?? {}
  const text = commandText(command, args)
  const processHandle = Bun.spawn([command, ...args], {
    env: spawnEnvironment(env),
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const exitCode = await awaitExit(processHandle, text, timeoutMs)
  if (exitCode !== 0) {
    throw new CommandFailure(text, exitCode, '')
  }
}

export async function captureCommand(
  command: string,
  args: string[],
  options?: RunOptions
): Promise<CapturedCommand> {
  const { timeoutMs = 0, env } = options ?? {}
  const text = commandText(command, args)
  const processHandle = Bun.spawn([command, ...args], {
    env: spawnEnvironment(env),
    stdin: 'inherit',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdoutPromise = new Response(processHandle.stdout).text()
  const stderrPromise = new Response(processHandle.stderr).text()
  let exitCode: number
  try {
    exitCode = await awaitExit(processHandle, text, timeoutMs)
  } catch (error) {
    // Drain the pipes so a killed child cannot leave the reads pending.
    await Promise.all([stdoutPromise, stderrPromise]).catch(() => undefined)
    throw error
  }
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise])
  if (exitCode !== 0) {
    throw new CommandFailure(text, exitCode, stderr)
  }
  return { exitCode, stdout, stderr }
}
