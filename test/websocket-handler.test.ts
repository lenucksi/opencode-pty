import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import { manager } from '../src/plugin/pty/manager.ts'
import { handleWebSocketMessage } from '../src/web/server/handlers/websocket.ts'
import type {
  PTYSessionInfo,
  WSMessageServer,
  WSMessageServerError,
  WSMessageServerReadRawResponse,
  WSMessageServerSessionList,
  WSMessageServerSubscribedSession,
  WSMessageServerUnsubscribedSession,
} from '../src/web/shared/types.ts'

function createFakeWebSocket() {
  const sent: WSMessageServer[] = []
  const subscribed: string[] = []
  const unsubscribed: string[] = []
  const ws = {
    send: (message: string) => {
      sent.push(JSON.parse(message) as WSMessageServer)
      return 0
    },
    subscribe: (topic: string) => {
      subscribed.push(topic)
    },
    unsubscribe: (topic: string) => {
      unsubscribed.push(topic)
    },
    subscriptions: new Set<string>(),
  } as unknown as ServerWebSocket<undefined>
  return { ws, sent, subscribed, unsubscribed }
}

function buildSession(overrides: Partial<PTYSessionInfo> = {}): PTYSessionInfo {
  return {
    id: 'pty_ws',
    title: 'WS session',
    command: 'echo',
    args: [],
    workdir: '/tmp',
    status: 'running',
    notifyOnExit: false,
    timedOut: false,
    pid: 1,
    createdAt: new Date().toISOString(),
    lineCount: 0,
    ...overrides,
  }
}

function lastError(sent: WSMessageServer[]): WSMessageServerError {
  const message = sent.at(-1)
  if (message?.type !== 'error') throw new Error('expected an error message')
  return message as WSMessageServerError
}

afterEach(() => {
  mock.restore()
})

describe('handleWebSocketMessage', () => {
  it('rejects binary messages with a helpful error', () => {
    const { ws, sent } = createFakeWebSocket()

    handleWebSocketMessage(ws, Buffer.from('binary'))

    expect(lastError(sent).error.message).toContain('Binary messages are not supported')
  })

  it('reports malformed JSON', () => {
    const { ws, sent } = createFakeWebSocket()

    handleWebSocketMessage(ws, 'not json')

    const message = lastError(sent).error.message
    expect(message).toContain('SyntaxError')
    expect(message).toContain('JSON Parse error')
  })

  it('subscribes to an existing session', () => {
    const { ws, sent, subscribed } = createFakeWebSocket()
    spyOn(manager, 'get').mockReturnValue(buildSession({ id: 'pty_abc' }))

    handleWebSocketMessage(ws, JSON.stringify({ type: 'subscribe', sessionId: 'pty_abc' }))

    expect(subscribed).toEqual(['session:pty_abc'])
    expect(sent.at(-1)).toEqual<WSMessageServerSubscribedSession>({
      type: 'subscribed',
      sessionId: 'pty_abc',
    })
  })

  it('errors when subscribing to a missing session', () => {
    const { ws, sent } = createFakeWebSocket()
    spyOn(manager, 'get').mockReturnValue(null)

    handleWebSocketMessage(ws, JSON.stringify({ type: 'subscribe', sessionId: 'pty_missing' }))

    expect(lastError(sent).error.message).toBe('Session pty_missing not found')
  })

  it('unsubscribes and acknowledges', () => {
    const { ws, sent, unsubscribed } = createFakeWebSocket()

    handleWebSocketMessage(ws, JSON.stringify({ type: 'unsubscribe', sessionId: 'pty_abc' }))

    expect(unsubscribed).toEqual(['session:pty_abc'])
    expect(sent.at(-1)).toEqual<WSMessageServerUnsubscribedSession>({
      type: 'unsubscribed',
      sessionId: 'pty_abc',
    })
  })

  it('responds to a session_list request', () => {
    const { ws, sent } = createFakeWebSocket()
    const sessions = [buildSession()]
    spyOn(manager, 'list').mockReturnValue(sessions)

    handleWebSocketMessage(ws, JSON.stringify({ type: 'session_list' }))

    expect(sent.at(-1)).toEqual<WSMessageServerSessionList>({ type: 'session_list', sessions })
  })

  it('writes input to a session', () => {
    const { ws } = createFakeWebSocket()
    const writeSpy = spyOn(manager, 'write').mockReturnValue(true)

    handleWebSocketMessage(
      ws,
      JSON.stringify({ type: 'input', sessionId: 'pty_abc', data: 'hello\n' })
    )

    expect(writeSpy).toHaveBeenCalledWith('pty_abc', 'hello\n')
  })

  it('resizes a session silently on success', () => {
    const { ws, sent } = createFakeWebSocket()
    const resizeSpy = spyOn(manager, 'resize').mockReturnValue(true)

    handleWebSocketMessage(
      ws,
      JSON.stringify({ type: 'resize', sessionId: 'pty_abc', cols: 80, rows: 24 })
    )

    expect(resizeSpy).toHaveBeenCalledWith('pty_abc', 80, 24)
    expect(sent).toHaveLength(0)
  })

  it('errors when resizing a missing session', () => {
    const { ws, sent } = createFakeWebSocket()
    spyOn(manager, 'resize').mockReturnValue(false)

    handleWebSocketMessage(
      ws,
      JSON.stringify({ type: 'resize', sessionId: 'pty_missing', cols: 80, rows: 24 })
    )

    expect(lastError(sent).error.message).toBe('Session pty_missing not found')
  })

  it('returns the raw buffer for a session', () => {
    const { ws, sent } = createFakeWebSocket()
    spyOn(manager, 'getRawBuffer').mockReturnValue({ raw: 'hello', byteLength: 5, offset: 0 })

    handleWebSocketMessage(ws, JSON.stringify({ type: 'readRaw', sessionId: 'pty_abc' }))

    expect(sent.at(-1)).toEqual<WSMessageServerReadRawResponse>({
      type: 'readRawResponse',
      sessionId: 'pty_abc',
      rawData: 'hello',
    })
  })

  it('errors when reading the raw buffer of a missing session', () => {
    const { ws, sent } = createFakeWebSocket()
    spyOn(manager, 'getRawBuffer').mockReturnValue(null)

    handleWebSocketMessage(ws, JSON.stringify({ type: 'readRaw', sessionId: 'pty_missing' }))

    expect(lastError(sent).error.message).toBe('Session pty_missing not found')
  })

  it('reports unknown message types', () => {
    const { ws, sent } = createFakeWebSocket()

    handleWebSocketMessage(ws, JSON.stringify({ type: 'bogus' }))

    expect(lastError(sent).error.message).toBe('Unknown message type bogus')
  })

  it('spawns a session and optionally subscribes to it', async () => {
    const { ws, sent, subscribed } = createFakeWebSocket()
    const spawnSpy = spyOn(manager, 'spawn').mockReturnValue(buildSession({ id: 'pty_new' }))
    spyOn(manager, 'get').mockReturnValue(buildSession({ id: 'pty_new' }))

    handleWebSocketMessage(
      ws,
      JSON.stringify({
        type: 'spawn',
        command: 'echo',
        args: ['hi'],
        subscribe: true,
        parentSessionId: 'websocket-test',
      })
    )
    await new Promise(setImmediate)

    expect(spawnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'echo', args: ['hi'], subscribe: true })
    )
    expect(subscribed).toEqual(['session:pty_new'])
    expect(sent.at(-1)).toEqual<WSMessageServerSubscribedSession>({
      type: 'subscribed',
      sessionId: 'pty_new',
    })
  })

  it('reports spawn failures without subscribing', async () => {
    const { ws, sent, subscribed } = createFakeWebSocket()
    spyOn(manager, 'spawn').mockImplementation(() => {
      throw new Error('spawn failed')
    })

    handleWebSocketMessage(ws, JSON.stringify({ type: 'spawn', command: 'echo', subscribe: true }))
    await new Promise(setImmediate)

    expect(lastError(sent).error.message).toBe('spawn failed')
    expect(subscribed).toHaveLength(0)
  })
})
