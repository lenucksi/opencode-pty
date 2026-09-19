import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { manager } from '../src/plugin/pty/manager.ts'
import { PTYPlugin } from '../src/plugin.ts'
import type { PluginContext, PluginResult } from '../src/plugin/types.ts'
import { PTYServer } from '../src/web/server/server.ts'

function createContext() {
  const prompt = mock(async () => ({}))
  const client = {
    session: { prompt },
  }
  return {
    prompt,
    context: { client, directory: '/workspace' } as unknown as PluginContext,
  }
}

function fakeServer(origin: string): PTYServer {
  return {
    server: { url: new URL(origin) },
  } as unknown as PTYServer
}

/** Minimal `command.execute.before` input/output pair. */
function commandInput(command: string, sessionID: string) {
  const input = { command, sessionID, arguments: '' }
  const output = { parts: [] }
  return [input, output] as const
}

afterEach(() => {
  mock.restore()
  manager.clearAllSessions()
})

describe('PTYPlugin entrypoint', () => {
  it('registers tools and the two slash commands', async () => {
    const { context } = createContext()
    const result = await PTYPlugin(context)

    expect(Object.keys(result.tool ?? {}).sort()).toEqual([
      'pty_kill',
      'pty_list',
      'pty_read',
      'pty_spawn',
      'pty_write',
    ])

    const input: { command?: Record<string, { template: string; description: string }> } = {}
    await result.config?.(input)

    expect(input.command?.['pty-open-background-spy']?.description).toBe(
      'Open PTY Sessions Web Interface'
    )
    expect(input.command?.['pty-show-server-url']?.description).toBe(
      'Show PTY Sessions Web Interface URL'
    )
  })

  it('ignores unrelated commands', async () => {
    const { context } = createContext()
    const result = await PTYPlugin(context)
    const execute = result['command.execute.before']

    await expect(execute?.(...commandInput('other-command', 'session-1'))).resolves.toBeUndefined()
  })

  it('handles the show-server-url command by prompting the session', async () => {
    const { context, prompt } = createContext()
    const result = await PTYPlugin(context)
    const createServer = spyOn(PTYServer, 'createServer').mockResolvedValue(
      fakeServer('http://127.0.0.1:43210')
    )

    const execute = result['command.execute.before']
    await expect(execute?.(...commandInput('pty-show-server-url', 'session-42'))).rejects.toThrow(
      'Command handled by PTY plugin'
    )

    expect(createServer).toHaveBeenCalledTimes(1)
    expect(prompt).toHaveBeenCalledWith({
      path: { id: 'session-42' },
      body: {
        noReply: true,
        parts: [
          {
            type: 'text',
            text: 'PTY Sessions Web Interface URL: http://127.0.0.1:43210',
          },
        ],
      },
    })
  })

  it('reuses a single server across command invocations', async () => {
    const { context } = createContext()
    const result = await PTYPlugin(context)
    const createServer = spyOn(PTYServer, 'createServer').mockResolvedValue(
      fakeServer('http://127.0.0.1:43211')
    )

    const execute = result['command.execute.before']
    await expect(execute?.(...commandInput('pty-show-server-url', 's1'))).rejects.toThrow()
    await expect(execute?.(...commandInput('pty-show-server-url', 's2'))).rejects.toThrow()

    expect(createServer).toHaveBeenCalledTimes(1)
  })

  it('cleans up PTY sessions when the parent session is deleted', async () => {
    const { context } = createContext()
    const result = await PTYPlugin(context)
    const cleanupSpy = spyOn(manager, 'cleanupBySession').mockImplementation(() => {})

    await result.event?.({
      event: { type: 'session.deleted', properties: { info: { id: 'parent-deleted' } } },
    } as Parameters<NonNullable<PluginResult['event']>>[0])

    expect(cleanupSpy).toHaveBeenCalledWith('parent-deleted')
  })
})
