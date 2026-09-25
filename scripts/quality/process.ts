export type EnvironmentOverrides = Record<string, string | undefined>

export interface CapturedCommand {
  exitCode: number
  stdout: string
  stderr: string
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

function spawnEnvironment(overrides?: EnvironmentOverrides): Record<string, string | undefined> {
  return { ...process.env, ...overrides }
}

function commandText(command: string, args: string[]): string {
  return [command, ...args].join(' ')
}

export async function runInherited(
  command: string,
  args: string[],
  overrides?: EnvironmentOverrides
): Promise<void> {
  const processHandle = Bun.spawn([command, ...args], {
    env: spawnEnvironment(overrides),
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const exitCode = await processHandle.exited
  if (exitCode !== 0) {
    throw new CommandFailure(commandText(command, args), exitCode, '')
  }
}

export async function captureCommand(
  command: string,
  args: string[],
  overrides?: EnvironmentOverrides
): Promise<CapturedCommand> {
  const processHandle = Bun.spawn([command, ...args], {
    env: spawnEnvironment(overrides),
    stdin: 'inherit',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ])
  if (exitCode !== 0) {
    throw new CommandFailure(commandText(command, args), exitCode, stderr)
  }
  return { exitCode, stdout, stderr }
}
