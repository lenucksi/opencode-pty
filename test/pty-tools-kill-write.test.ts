import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { manager } from '../src/plugin/pty/manager.ts'
import { setPermissionAuthorizer } from '../src/plugin/pty/permissions.ts'
import { ptyKill } from '../src/plugin/pty/tools/kill.ts'
import { ptyWrite } from '../src/plugin/pty/tools/write.ts'
import type { PTYSessionInfo } from '../src/plugin/pty/types.ts'

function buildSession(overrides: Partial<PTYSessionInfo> = {}): PTYSessionInfo {
  return {
    id: 'pty_killwrite',
    title: 'Kill/write session',
    command: 'cat',
    args: [],
    workdir: '/tmp',
    status: 'running',
    notifyOnExit: false,
    timedOut: false,
    pid: 4242,
    createdAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    lineCount: 7,
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

describe('ptyKill tool', () => {
  afterEach(() => {
    mock.restore()
  })

  it('kills a running session and retains it for log access by default', async () => {
    spyOn(manager, 'get').mockReturnValue(buildSession())
    const killSpy = spyOn(manager, 'kill').mockReturnValue(true)

    const result = await ptyKill.execute({ id: 'pty_killwrite' }, ctx)

    expect(manager.get).toHaveBeenCalledWith('pty_killwrite')
    expect(killSpy).toHaveBeenCalledWith('pty_killwrite', false)
    expect(result).toContain('<pty_killed>')
    expect(result).toContain('Killed: pty_killwrite (session retained for log access)')
    expect(result).toContain('Title: Kill/write session')
    expect(result).toContain('Command: cat ')
    expect(result).toContain('Final line count: 7')
    expect(result).toContain('</pty_killed>')
  })

  it('reports a cleanup kill when cleanup is true', async () => {
    spyOn(manager, 'get').mockReturnValue(buildSession())
    const killSpy = spyOn(manager, 'kill').mockReturnValue(true)

    const result = await ptyKill.execute({ id: 'pty_killwrite', cleanup: true }, ctx)

    expect(killSpy).toHaveBeenCalledWith('pty_killwrite', true)
    expect(result).toContain('Killed: pty_killwrite (session removed)')
  })

  it('labels an already-exited session as cleaned up', async () => {
    spyOn(manager, 'get').mockReturnValue(buildSession({ status: 'exited', exitCode: 0 }))
    spyOn(manager, 'kill').mockReturnValue(true)

    const result = await ptyKill.execute({ id: 'pty_killwrite', cleanup: true }, ctx)

    expect(result).toContain('Cleaned up: pty_killwrite (session removed)')
  })

  it('throws when the session does not exist', async () => {
    spyOn(manager, 'get').mockReturnValue(null)

    expect(ptyKill.execute({ id: 'pty_missing' }, ctx)).rejects.toThrow(
      "PTY session 'pty_missing' not found"
    )
  })

  it('throws when the manager fails to kill the session', async () => {
    spyOn(manager, 'get').mockReturnValue(buildSession())
    spyOn(manager, 'kill').mockReturnValue(false)

    expect(ptyKill.execute({ id: 'pty_killwrite' }, ctx)).rejects.toThrow(
      "Failed to kill PTY session 'pty_killwrite'."
    )
  })
})

describe('ptyWrite tool', () => {
  afterEach(() => {
    mock.restore()
    setPermissionAuthorizer(null)
  })

  it('writes data to a running session and reports the byte count', async () => {
    spyOn(manager, 'get').mockReturnValue(buildSession())
    const writeSpy = spyOn(manager, 'write').mockReturnValue(true)

    const result = await ptyWrite.execute({ id: 'pty_killwrite', data: 'hello world' }, ctx)

    expect(writeSpy).toHaveBeenCalledWith('pty_killwrite', 'hello world')
    expect(result).toBe('Sent 11 bytes to pty_killwrite: "hello world"')
  })

  it('parses escape sequences before writing', async () => {
    spyOn(manager, 'get').mockReturnValue(buildSession())
    const writeSpy = spyOn(manager, 'write').mockReturnValue(true)

    await ptyWrite.execute({ id: 'pty_killwrite', data: 'a\\nb\\tc\\x41\\u0042\\\\d\\r' }, ctx)

    expect(writeSpy).toHaveBeenCalledWith('pty_killwrite', 'a\nb\tcAB\\d\r')
  })

  it('truncates the preview for long payloads and renders control characters', async () => {
    spyOn(manager, 'get').mockReturnValue(buildSession())
    spyOn(manager, 'write').mockReturnValue(true)

    const long = 'x'.repeat(60)
    const result = await ptyWrite.execute({ id: 'pty_killwrite', data: long }, ctx)
    expect(result).toContain(`"${'x'.repeat(50)}..."`)
    expect(result).toContain(`Sent ${long.length} bytes`)

    const withControls = `${String.fromCharCode(3)}${String.fromCharCode(4)}line1\nline2\r`
    const controlResult = await ptyWrite.execute({ id: 'pty_killwrite', data: withControls }, ctx)
    expect(controlResult).toContain('^C^Dline1\\nline2\\r')
  })

  it('checks permission for every non-empty command line', async () => {
    spyOn(manager, 'get').mockReturnValue(buildSession())
    spyOn(manager, 'write').mockReturnValue(true)
    const checked: Array<{ command: string; args: string[] }> = []
    setPermissionAuthorizer({
      checkCommand: async (command, args) => {
        checked.push({ command, args })
      },
      checkWorkdir: async () => {},
    })

    await ptyWrite.execute(
      {
        id: 'pty_killwrite',
        data: 'ls -la\n\nrm -rf /tmp/x\n',
      },
      ctx
    )

    expect(checked).toEqual([
      { command: 'ls', args: ['-la'] },
      { command: 'rm', args: ['-rf', '/tmp/x'] },
    ])
  })

  it('propagates permission denial without writing', async () => {
    spyOn(manager, 'get').mockReturnValue(buildSession())
    const writeSpy = spyOn(manager, 'write').mockReturnValue(true)
    setPermissionAuthorizer({
      checkCommand: async () => {
        throw new Error('denied by policy')
      },
      checkWorkdir: async () => {},
    })

    expect(ptyWrite.execute({ id: 'pty_killwrite', data: 'rm -rf /\n' }, ctx)).rejects.toThrow(
      'denied by policy'
    )
    expect(writeSpy).not.toHaveBeenCalled()
  })

  it('throws when the session does not exist', async () => {
    spyOn(manager, 'get').mockReturnValue(null)

    expect(ptyWrite.execute({ id: 'pty_missing', data: 'x' }, ctx)).rejects.toThrow(
      "PTY session 'pty_missing' not found"
    )
  })

  it('refuses to write to a non-running session', async () => {
    spyOn(manager, 'get').mockReturnValue(buildSession({ status: 'exited' }))

    expect(ptyWrite.execute({ id: 'pty_killwrite', data: 'x' }, ctx)).rejects.toThrow(
      "Cannot write to PTY 'pty_killwrite' - session status is 'exited'."
    )
  })

  it('throws when the underlying write fails', async () => {
    spyOn(manager, 'get').mockReturnValue(buildSession())
    spyOn(manager, 'write').mockReturnValue(false)

    expect(ptyWrite.execute({ id: 'pty_killwrite', data: 'x' }, ctx)).rejects.toThrow(
      "Failed to write to PTY 'pty_killwrite'."
    )
  })
})
