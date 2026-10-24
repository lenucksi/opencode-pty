import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'

import { manager } from '../src/plugin/pty/manager.ts'
import { notifySessionUpdate } from '../src/plugin/pty/manager-notifications.ts'
import { ptyWait } from '../src/plugin/pty/tools/wait.ts'
import type { PTYSessionInfo } from '../src/plugin/pty/types.ts'
import { setWaitPolicy } from '../src/plugin/pty/wait-policy.ts'

/**
 * Waiting for quiet.
 *
 * The wait had one ending: the session exits. "Send a command, wait for the prompt"
 * is the other half of what a wait is for, and it needs a different signal - no
 * output for a while, with the process still running. These cases pin that signal,
 * including the part that is easy to get wrong: a quiet result must not claim an
 * exit status it does not have.
 */

function session(overrides: Partial<PTYSessionInfo> = {}): PTYSessionInfo {
  return {
    id: 'pty_waitquiet',
    title: 'Quiet session',
    command: 'bash',
    args: ['-i'],
    workdir: '/tmp',
    status: 'running',
    notifyOnExit: false,
    timedOut: false,
    pid: 4242,
    createdAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    lineCount: 3,
    cols: 240,
    rows: 80,
    charCount: 120,
    ...overrides,
  }
}

const ctx = {
  sessionID: 'parent',
  messageID: 'msg',
  agent: 'agent',
  abort: new AbortController().signal,
  metadata: () => {},
  ask: async () => {},
  directory: '/tmp',
  worktree: '/tmp',
}

describe('ptyWait with quietMs', () => {
  afterEach(() => {
    mock.restore()
    // `{}` is the default policy: no cap, no heartbeat - what the OpenCode route
    // installs. `null` is not a policy and the next case would read through it.
    setWaitPolicy({})
  })

  it('returns once the output has stopped moving, with the process still running', async () => {
    spyOn(manager, 'get').mockReturnValue(session())
    spyOn(manager, 'read').mockReturnValue(null)

    const started = Date.now()
    const result = await ptyWait.execute({ id: 'pty_waitquiet', quietMs: 120 }, ctx as never)
    const elapsed = Date.now() - started

    // Two samples at the 50 ms floor: the wait is at least the window it was asked for.
    expect(elapsed).toBeGreaterThanOrEqual(100)
    expect(result).toContain('reason="quiet"')
    expect(result).toContain('Still running: yes')
    // A quiet session has no exit status, and saying "Exit: unknown" would read as
    // if it had died.
    expect(result).not.toContain('Exit:')
  })

  it('keeps waiting while the output is still moving', async () => {
    let chars = 120
    spyOn(manager, 'get').mockImplementation((() => session({ charCount: chars })) as never)
    spyOn(manager, 'read').mockReturnValue(null)
    // Every sample sees new output, so the quiet window never completes and only the
    // timeout can end the wait.
    const ticker = setInterval(() => {
      chars += 10
    }, 30)

    try {
      const result = await ptyWait.execute(
        { id: 'pty_waitquiet', quietMs: 100, timeoutSeconds: 0.4 },
        ctx as never
      )
      expect(result).toContain('<pty_wait_timeout')
    } finally {
      clearInterval(ticker)
    }
  })

  it('reports an exit as an exit, even with quietMs set', async () => {
    const running = session()
    const ended = session({ status: 'exited', exitCode: 0 })
    spyOn(manager, 'get').mockReturnValue(running)
    spyOn(manager, 'read').mockReturnValue(null)
    // The session ends before its output can go quiet. The exit arrives the way it
    // does in production: as a session update, not by the snapshot changing under a
    // poll - a quiet timer must not outlive the thing it was watching.
    setTimeout(() => notifySessionUpdate(ended), 40)

    const result = await ptyWait.execute({ id: 'pty_waitquiet', quietMs: 5_000 }, ctx as never)

    expect(result).toContain('reason="exit"')
    expect(result).toContain('Exit: 0')
  })

  it('returns at once for a session that has already ended', async () => {
    spyOn(manager, 'get').mockReturnValue(session({ status: 'exited', exitCode: 3 }))
    spyOn(manager, 'read').mockReturnValue(null)

    const result = await ptyWait.execute({ id: 'pty_waitquiet', quietMs: 5_000 }, ctx as never)

    expect(result).toContain('reason="exit"')
    expect(result).toContain('Exit: 3')
  })

  it('does not treat the route cap as a second meaning for "done"', async () => {
    setWaitPolicy({ maxSeconds: 30, heartbeat: () => {} })
    spyOn(manager, 'get').mockReturnValue(session())
    spyOn(manager, 'read').mockReturnValue(null)

    const result = await ptyWait.execute({ id: 'pty_waitquiet', quietMs: 80 }, ctx as never)

    expect(result).toContain('reason="quiet"')
    expect(result).not.toContain('Exit:')
  })

  it('refuses to answer for a session that no longer exists', async () => {
    spyOn(manager, 'get').mockReturnValue(null)

    await expect(ptyWait.execute({ id: 'pty_gone', quietMs: 100 }, ctx as never)).rejects.toThrow(
      "PTY session 'pty_gone' not found"
    )
  })
})
