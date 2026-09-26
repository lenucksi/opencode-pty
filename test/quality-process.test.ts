import { describe, expect, test } from 'bun:test'

import {
  captureCommand,
  CommandFailure,
  CommandTimeout,
  runInherited,
} from '../scripts/quality/process.ts'

/**
 * A hanging step must fail the gate, not block it.
 *
 * `socket ci` and `bun outdated` both hung indefinitely on a dead connection and
 * left the whole gate stuck with no failure reported and no way forward.
 */

describe('command timeouts', () => {
  test('kills and reports a child that overruns', async () => {
    const started = Date.now()
    await expect(runInherited('sleep', ['30'], { timeoutMs: 300 })).rejects.toBeInstanceOf(
      CommandTimeout
    )
    // Well under the child's own runtime, so the kill - not the exit - ended it.
    expect(Date.now() - started).toBeLessThan(5000)
  })

  test('names the command and the limit in the message', async () => {
    const error = await runInherited('sleep', ['30'], { timeoutMs: 200 }).catch(
      (cause: unknown) => cause
    )
    expect(error).toBeInstanceOf(CommandTimeout)
    expect((error as CommandTimeout).command).toBe('sleep 30')
    expect((error as CommandTimeout).timeoutMs).toBe(200)
    expect((error as CommandTimeout).message).toContain('timed out')
  })

  test('times out a captured child too and drains its pipes', async () => {
    await expect(captureCommand('sleep', ['30'], { timeoutMs: 300 })).rejects.toBeInstanceOf(
      CommandTimeout
    )
  })

  test('still fails on a non-zero exit', async () => {
    const error = await runInherited('sh', ['-c', 'exit 7'], { timeoutMs: 10_000 }).catch(
      (cause: unknown) => cause
    )
    expect(error).toBeInstanceOf(CommandFailure)
    expect((error as CommandFailure).exitCode).toBe(7)
  })

  test('lets a fast command finish untouched', async () => {
    const result = await captureCommand('echo', ['ok'], { timeoutMs: 10_000 })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe('ok')
  })

  test('passes environment overrides alongside the timeout', async () => {
    const result = await captureCommand('sh', ['-c', 'printf %s "$PTY_GATE_TEST"'], {
      env: { PTY_GATE_TEST: 'value' },
      timeoutMs: 10_000,
    })
    expect(result.stdout).toBe('value')
  })
})
