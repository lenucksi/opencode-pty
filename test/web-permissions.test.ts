import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import { manager } from '../src/plugin/pty/manager.ts'
import {
  setPermissionAuthorizer,
  type PermissionAuthorizer,
} from '../src/plugin/pty/permissions.ts'
import type { PTYSessionInfo } from '../src/plugin/pty/types.ts'
import { createSession } from '../src/web/server/handlers/sessions.ts'
import { handleWebSocketMessage } from '../src/web/server/handlers/websocket.ts'
import type { WSMessageServerError } from '../src/web/shared/types.ts'

/**
 * The web interface and the permission gate.
 *
 * Inside OpenCode the gate is the host's: the model's tool calls carry a session,
 * and the host evaluates its rules and prompts the user. A browser talking to the
 * web interface has no session - there is no conversation the rules could belong
 * to - so the host cannot be asked about it.
 *
 * The seam is what matters here: the web interface asks the same question every
 * other route asks, so a policy of its own (the one the MCP route and the
 * standalone binary will use) drops into the same place and refuses what it
 * refuses.
 */

function buildSpawnInfo(overrides: Partial<PTYSessionInfo> = {}): PTYSessionInfo {
  return {
    id: 'pty_denied_test',
    title: 'Denied test',
    command: 'echo',
    args: ['blocked'],
    workdir: process.cwd(),
    status: 'running',
    notifyOnExit: false,
    timedOut: false,
    pid: 1234,
    createdAt: new Date().toISOString(),
    lineCount: 0,
    cols: 240,
    rows: 80,
    charCount: 0,
    ...overrides,
  }
}

function createFakeWebSocket(sentMessages: string[]): ServerWebSocket<undefined> {
  return {
    send: (message: string) => {
      sentMessages.push(message)
      return 0
    },
    subscribe: () => {},
    unsubscribe: () => {},
    subscriptions: new Set<string>(),
  } as unknown as ServerWebSocket<undefined>
}

/** A policy that refuses everything, standing in for the one the MCP route will use. */
function refusingPolicy(): PermissionAuthorizer {
  return {
    checkCommand: async () => {
      throw new Error('PTY spawn denied: the policy refuses this command.')
    },
    checkWorkdir: async () => {},
  }
}

describe('the web interface and the permission gate', () => {
  afterEach(() => {
    setPermissionAuthorizer(null)
    mock.restore()
  })

  it('refuses REST session creation when the policy refuses the command', async () => {
    setPermissionAuthorizer(refusingPolicy())
    const spawnSpy = spyOn(manager, 'spawn').mockReturnValue(buildSpawnInfo())

    const response = await createSession(
      new Request('http://localhost/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: 'echo',
          args: ['blocked'],
          description: 'Denied REST session',
        }),
      })
    )

    expect(response.status).toBe(400)
    expect(await response.text()).toContain('the policy refuses this command')
    expect(spawnSpy).not.toHaveBeenCalled()
  })

  it('refuses WebSocket session creation when the policy refuses the command', async () => {
    setPermissionAuthorizer(refusingPolicy())
    const spawnSpy = spyOn(manager, 'spawn').mockReturnValue(buildSpawnInfo())
    const sentMessages: string[] = []

    await handleWebSocketMessage(
      createFakeWebSocket(sentMessages),
      JSON.stringify({
        type: 'spawn',
        command: 'echo',
        args: ['blocked'],
        description: 'Denied WebSocket session',
        parentSessionId: 'websocket-test',
      })
    )
    await new Promise(setImmediate)

    expect(spawnSpy).not.toHaveBeenCalled()
    expect(sentMessages).toHaveLength(1)
    const message = JSON.parse(sentMessages[0] ?? '{}') as WSMessageServerError
    expect(message.type).toBe('error')
    expect(message.error.message).toContain('the policy refuses this command')
  })

  // The host cannot answer for a session it does not know, and a browser has no
  // session. That is the whole reason the web interface asks a policy of its own
  // rather than the host.
  it('starts what the user asked for, because the host has no session to ask about', async () => {
    const spawnSpy = spyOn(manager, 'spawn').mockReturnValue(buildSpawnInfo())

    const response = await createSession(
      new Request('http://localhost/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: 'echo',
          args: ['allowed'],
          description: 'Web session',
        }),
      })
    )

    expect(response.status).toBe(200)
    expect(spawnSpy).toHaveBeenCalled()
  })
})
