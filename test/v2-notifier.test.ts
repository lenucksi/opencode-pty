import { describe, expect, it, mock } from 'bun:test'
import { RingBuffer } from '../src/plugin/pty/buffer.ts'
import type { PtyLogger } from '../src/plugin/pty/plugin-log.ts'
import type { PTYSession } from '../src/plugin/pty/types.ts'
import { V2SessionNotifier, type V2SessionPrompt } from '../src/v2/notifier.ts'

function createSession(overrides: Partial<PTYSession> = {}): PTYSession {
  const buffer = new RingBuffer()
  buffer.append('PLAY RECAP\nok=38 changed=13 failed=0\n')

  return {
    id: 'pty_test',
    title: 'Test Session',
    description: 'Test session description',
    command: 'ansible-playbook',
    args: ['site.yml'],
    workdir: '/tmp',
    status: 'exited',
    pid: 12345,
    createdAt: new Date(),
    parentSessionId: 'parent-session',
    parentAgent: 'build',
    notifyOnExit: true,
    timeoutSeconds: undefined,
    timedOut: false,
    buffer,
    process: null,
    ...overrides,
  }
}

function captureLogger(): { log: PtyLogger; entries: string[] } {
  const entries: string[] = []
  const log: PtyLogger = (level, message, details) => {
    entries.push([level, message, details === undefined ? '' : JSON.stringify(details)].join(' '))
  }
  return { log, entries }
}

describe('V2SessionNotifier', () => {
  it('delivers the notification as a user prompt under a deterministic id', async () => {
    const prompt = mock(async (_input: unknown) => {})
    const { log, entries } = captureLogger()
    const notifier = new V2SessionNotifier({ prompt } as unknown as V2SessionPrompt, log)

    await notifier.sendExitNotification(createSession(), 3)

    const input = prompt.mock.calls[0]?.[0] as { sessionID: string; id: string; text: string }
    expect(input.sessionID).toBe('parent-session')
    expect(input.id).toBe('pty_pty_test_exited')
    expect(input.text).toContain('<pty_exited>')
    expect(input.text).toContain('Exit Code: 3')
    expect(input.text).toContain('ok=38')
    expect(entries.some((entry) => entry.includes('delivered'))).toBe(true)
  })

  it('reports a lazy (non-promise) host result instead of pretending it was delivered', async () => {
    // Effect-based hosts hand back a value that is not thenable; awaiting it
    // resolves immediately, so this used to look like a successful delivery
    // while nothing ever reached the session.
    const prompt = mock((_input: unknown) => ({ _tag: 'Effect' }))
    const { log, entries } = captureLogger()
    const notifier = new V2SessionNotifier({ prompt } as unknown as V2SessionPrompt, log)

    await notifier.sendExitNotification(createSession(), 0)

    expect(entries.some((entry) => entry.includes('non-promise'))).toBe(true)
  })

  it('logs delivery failures instead of throwing', async () => {
    const prompt = mock(async (_input: unknown) => {
      throw new Error('prompt rejected')
    })
    const { log, entries } = captureLogger()
    const notifier = new V2SessionNotifier({ prompt } as unknown as V2SessionPrompt, log)

    await expect(notifier.sendExitNotification(createSession(), 0)).resolves.toBeUndefined()
    expect(entries.some((entry) => entry.includes('failed to deliver'))).toBe(true)
  })

  it('warns when the session has no parent session to wake', async () => {
    const prompt = mock(async (_input: unknown) => {})
    const { log, entries } = captureLogger()
    const notifier = new V2SessionNotifier({ prompt } as unknown as V2SessionPrompt, log)

    await notifier.sendExitNotification(createSession({ parentSessionId: '' }), 0)

    expect(prompt).not.toHaveBeenCalled()
    expect(entries.some((entry) => entry.includes('no parent session'))).toBe(true)
  })
})
