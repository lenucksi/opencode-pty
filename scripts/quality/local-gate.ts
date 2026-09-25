import { existsSync } from 'node:fs'

import { runAislopCheck } from './aislop.ts'
import { runBunToolchainCheck, runDependencyCheck } from './dependencies.ts'
import { CommandFailure, runInherited } from './process.ts'

export const SOCKET_SCAN_COMMAND = ['bunx', 'socket@1.1.180', 'ci'] as const

interface StepResult {
  name: string
  status: 'PASS' | 'SKIP' | 'FAIL'
  durationMs: number
  detail?: string
}

function formatError(error: unknown): string {
  if (error instanceof CommandFailure) {
    return error.stderr ? `${error.message}\n${error.stderr}` : error.message
  }
  return error instanceof Error ? error.message : String(error)
}

class StepRecorder {
  private readonly results: StepResult[] = []

  public async run(name: string, action: () => Promise<void>): Promise<void> {
    const startedAt = performance.now()
    console.log(`\n[quality] ${name}`)
    try {
      await action()
      this.add(name, 'PASS', startedAt)
    } catch (error) {
      this.add(name, 'FAIL', startedAt, formatError(error))
      throw error
    }
  }

  public skip(name: string, detail: string): void {
    console.log(`\n[quality] ${name}\n[quality] SKIP: ${detail}`)
    this.results.push({ name, status: 'SKIP', durationMs: 0, detail })
  }

  public printSummary(): void {
    console.log('\n=== Local quality summary ===')
    for (const result of this.results) {
      const duration = result.durationMs > 0 ? ` (${Math.round(result.durationMs)}ms)` : ''
      const detail = result.detail ? `: ${result.detail}` : ''
      console.log(`${result.status.padEnd(4)} ${result.name}${duration}${detail}`)
    }
  }

  private add(
    name: string,
    status: StepResult['status'],
    startedAt: number,
    detail?: string
  ): void {
    this.results.push({
      name,
      status,
      durationMs: performance.now() - startedAt,
      ...(detail ? { detail } : {}),
    })
  }
}

function requireTool(name: string): void {
  if (!Bun.which(name)) throw new Error(`${name} is required but was not found in PATH`)
}

function requireLocalTools(): void {
  requireTool('gitleaks')
  requireTool('trufflehog')
}

async function runSocketStep(recorder: StepRecorder): Promise<void> {
  const [command, ...args] = SOCKET_SCAN_COMMAND
  if (!command) throw new Error('Socket scan command is empty')
  await recorder.run('Socket.dev policy scan', async () => {
    await runInherited(command, args, { CI: 'true' })
  })
}

async function runE2eStep(): Promise<void> {
  if (existsSync('.local/e2e-local.sh')) {
    await runInherited('bash', ['.local/e2e-local.sh', '--project=chromium'])
    return
  }
  await runInherited('bun', ['run', 'test:e2e'])
}

async function runSecretStep(name: string, command: string, args: string[]): Promise<void> {
  await runInherited(command, args)
  console.log(`${name} passed`)
}

export async function runLocalQualityGate(): Promise<number> {
  const recorder = new StepRecorder()
  try {
    await recorder.run('Bun and security tools', async () => {
      await runBunToolchainCheck()
      requireLocalTools()
    })
    await recorder.run('Frozen dependency install', () =>
      runInherited('bun', ['install', '--force', '--frozen-lockfile'])
    )
    await recorder.run('Dependency audit and freshness', runDependencyCheck)
    await runSocketStep(recorder)
    await recorder.run('Typecheck', () => runInherited('bun', ['run', 'typecheck']))
    await recorder.run('Lint', () => runInherited('bun', ['run', 'lint']))
    await recorder.run('Format', () => runInherited('bun', ['run', 'format']))
    await recorder.run('Aislop', runAislopCheck)
    await recorder.run('Production build for tests', () =>
      runInherited('bun', ['run', 'build:prod'])
    )
    await recorder.run('Unit tests', () => runInherited('bun', ['run', 'unittest']))
    await recorder.run('Coverage', () => runInherited('bun', ['run', 'test:coverage']))
    await recorder.run('End-to-end tests', runE2eStep)
    await recorder.run('Final production build', () => runInherited('bun', ['run', 'build:prod']))
    await recorder.run('Gitleaks', () =>
      runSecretStep('Gitleaks', 'gitleaks', [
        'git',
        '--no-banner',
        '--redact',
        '--log-opts=--all',
        '.',
      ])
    )
    await recorder.run('TruffleHog', () =>
      runSecretStep('TruffleHog', 'trufflehog', [
        'git',
        `file://${process.cwd()}`,
        '--results=verified',
        '--no-update',
        '--no-color',
        '--fail',
      ])
    )
  } catch {
    recorder.printSummary()
    return 1
  }
  recorder.printSummary()
  return 0
}
