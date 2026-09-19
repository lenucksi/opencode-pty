import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import type { BunRequest } from 'bun'
import { manager } from '../src/plugin/pty/manager.ts'
import { setPermissionAuthorizer } from '../src/plugin/pty/permissions.ts'
import { handleHealth } from '../src/web/server/handlers/health.ts'
import {
  cleanupSession,
  clearSessions,
  createSession,
  getPlainBuffer,
  getRawBuffer,
  getSession,
  getSessions,
  killSession,
  sendInput,
} from '../src/web/server/handlers/sessions.ts'
import { handleUpgrade } from '../src/web/server/handlers/upgrade.ts'
import type { HealthResponse } from '../src/web/shared/types.ts'
import type { routes } from '../src/web/shared/routes.ts'

afterEach(() => {
  setPermissionAuthorizer(null)
  mock.restore()
})

describe('handleHealth', () => {
  it('reports session counts, uptime and websocket connections', async () => {
    spyOn(manager, 'list').mockReturnValue([
      { status: 'running' },
      { status: 'exited' },
      { status: 'running' },
    ] as ReturnType<typeof manager.list>)

    const response = handleHealth({
      pendingWebSockets: 4,
    } as unknown as Bun.Server<undefined>)

    expect(response.status).toBe(200)
    const body = (await response.json()) as HealthResponse
    expect(body.status).toBe('healthy')
    expect(body.sessions).toEqual({ total: 3, active: 2 })
    expect(body.websocket.connections).toBe(4)
    expect(body.uptime).toBeGreaterThan(0)
    expect(body.memory?.rss).toBeGreaterThan(0)
    expect(body.responseTime).toBeGreaterThanOrEqual(0)
  })
})

describe('session handlers', () => {
  const sessionInfo = {
    id: 'pty_web',
    title: 'Web session',
    command: 'echo',
    args: [],
    workdir: '/tmp',
    status: 'running' as const,
    notifyOnExit: false,
    timedOut: false,
    pid: 1,
    createdAt: new Date().toISOString(),
    lineCount: 0,
  }

  it('lists sessions', async () => {
    spyOn(manager, 'list').mockReturnValue([sessionInfo])
    const response = getSessions()
    expect(await response.json()).toEqual([sessionInfo])
  })

  it('rejects invalid JSON bodies', async () => {
    const response = await createSession(
      new Request('http://localhost/api/sessions', { method: 'POST', body: 'not-json' })
    )
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('Invalid JSON in request body')
  })

  it('requires a non-empty command', async () => {
    for (const body of [{}, { command: '   ' }, { command: 5 }]) {
      const response = await createSession(
        new Request('http://localhost/api/sessions', {
          method: 'POST',
          body: JSON.stringify(body),
        })
      )
      expect(response.status).toBe(400)
      expect(await response.text()).toContain('Command is required')
    }
  })

  it('creates a session and checks command/workdir permissions', async () => {
    const checks: string[] = []
    setPermissionAuthorizer({
      checkCommand: async (command) => {
        checks.push(`cmd:${command}`)
      },
      checkWorkdir: async (workdir) => {
        checks.push(`dir:${workdir}`)
      },
    })
    const spawnSpy = spyOn(manager, 'spawn').mockReturnValue(sessionInfo)

    const response = await createSession(
      new Request('http://localhost/api/sessions', {
        method: 'POST',
        body: JSON.stringify({
          command: 'echo',
          args: ['hi'],
          description: 'Web session',
          workdir: '/tmp',
          timeoutSeconds: 10,
        }),
      })
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(sessionInfo)
    expect(checks).toEqual(['cmd:echo', 'dir:/tmp'])
    expect(spawnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'echo',
        args: ['hi'],
        workdir: '/tmp',
        timeoutSeconds: 10,
        parentSessionId: 'web-api',
      })
    )
  })

  it('surfaces spawn errors as a 400', async () => {
    spyOn(manager, 'spawn').mockImplementation(() => {
      throw new Error('spawn exploded')
    })
    const response = await createSession(
      new Request('http://localhost/api/sessions', {
        method: 'POST',
        body: JSON.stringify({ command: 'echo' }),
      })
    )
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('spawn exploded')
  })

  it('clears all sessions', async () => {
    const clearSpy = spyOn(manager, 'clearAllSessions').mockImplementation(() => {})
    const response = clearSessions()
    expect(clearSpy).toHaveBeenCalled()
    expect(await response.json()).toEqual({ success: true })
  })

  it('fetches a session or returns 404', async () => {
    spyOn(manager, 'get').mockReturnValue(sessionInfo)
    const found = getSession({
      params: { id: 'pty_web' },
    } as unknown as BunRequest<typeof routes.session.path>)
    expect(await found.json()).toEqual(sessionInfo)

    spyOn(manager, 'get').mockReturnValue(null)
    const missing = getSession({
      params: { id: 'nope' },
    } as unknown as BunRequest<typeof routes.session.path>)
    expect(missing.status).toBe(404)
  })

  describe('sendInput', () => {
    it('rejects invalid JSON', async () => {
      const request = {
        params: { id: 'pty_web' },
        json: async () => {
          throw new Error('bad json')
        },
      } as unknown as BunRequest<typeof routes.session.input.path>

      const response = await sendInput(request)
      expect(response.status).toBe(400)
      expect(await response.text()).toContain('Invalid JSON in request body')
    })

    it('requires a string data field', async () => {
      const request = {
        params: { id: 'pty_web' },
        json: async () => ({ data: 123 }),
      } as unknown as BunRequest<typeof routes.session.input.path>

      const response = await sendInput(request)
      expect(response.status).toBe(400)
      expect(await response.text()).toContain('Data field is required')
    })

    it('reports a write failure', async () => {
      spyOn(manager, 'write').mockReturnValue(false)
      const request = {
        params: { id: 'pty_web' },
        json: async () => ({ data: 'hello' }),
      } as unknown as BunRequest<typeof routes.session.input.path>

      const response = await sendInput(request)
      expect(response.status).toBe(400)
      expect(await response.text()).toContain('Failed to write to session')
    })

    it('writes data on success', async () => {
      const writeSpy = spyOn(manager, 'write').mockReturnValue(true)
      const request = {
        params: { id: 'pty_web' },
        json: async () => ({ data: 'hello' }),
      } as unknown as BunRequest<typeof routes.session.input.path>

      const response = await sendInput(request)
      expect(writeSpy).toHaveBeenCalledWith('pty_web', 'hello')
      expect(await response.json()).toEqual({ success: true })
    })
  })

  it('cleans up a session', async () => {
    const killSpy = spyOn(manager, 'kill').mockReturnValue(true)
    const response = cleanupSession({
      params: { id: 'pty_web' },
    } as unknown as BunRequest<typeof routes.session.cleanup.path>)
    expect(killSpy).toHaveBeenCalledWith('pty_web', true)
    expect(await response.json()).toEqual({ success: true })

    spyOn(manager, 'kill').mockReturnValue(false)
    const failed = cleanupSession({
      params: { id: 'pty_web' },
    } as unknown as BunRequest<typeof routes.session.cleanup.path>)
    expect(failed.status).toBe(400)
  })

  it('kills a session', async () => {
    const killSpy = spyOn(manager, 'kill').mockReturnValue(true)
    const response = killSession({
      params: { id: 'pty_web' },
    } as unknown as BunRequest<typeof routes.session.path>)
    expect(killSpy).toHaveBeenCalledWith('pty_web')
    expect(await response.json()).toEqual({ success: true })

    spyOn(manager, 'kill').mockReturnValue(false)
    const failed = killSession({
      params: { id: 'pty_web' },
    } as unknown as BunRequest<typeof routes.session.path>)
    expect(failed.status).toBe(400)
  })

  describe('raw buffer', () => {
    const bufferData = { raw: 'hello world', byteLength: 11, offset: 0 }

    it('returns the buffer and honours a finite `since`', async () => {
      const getRawBufferSpy = spyOn(manager, 'getRawBuffer').mockReturnValue(bufferData)
      const response = getRawBuffer({
        params: { id: 'pty_web' },
        url: 'http://localhost/api/sessions/pty_web/buffer/raw?since=5',
      } as unknown as BunRequest<typeof routes.session.buffer.raw.path>)

      expect(getRawBufferSpy).toHaveBeenCalledWith('pty_web', 5)
      expect(await response.json()).toEqual(bufferData)
    })

    it('ignores non-numeric or empty `since` values', async () => {
      const getRawBufferSpy = spyOn(manager, 'getRawBuffer').mockReturnValue(bufferData)

      for (const since of ['abc', '', 'NaN']) {
        getRawBuffer({
          params: { id: 'pty_web' },
          url: `http://localhost/api/sessions/pty_web/buffer/raw?since=${since}`,
        } as unknown as BunRequest<typeof routes.session.buffer.raw.path>)
      }

      expect(getRawBufferSpy).toHaveBeenCalledTimes(3)
      for (const call of getRawBufferSpy.mock.calls) {
        expect(call[1]).toBeUndefined()
      }
    })

    it('returns 404 when the session is gone', async () => {
      spyOn(manager, 'getRawBuffer').mockReturnValue(null)
      const response = getRawBuffer({
        params: { id: 'missing' },
        url: 'http://localhost/api/sessions/missing/buffer/raw',
      } as unknown as BunRequest<typeof routes.session.buffer.raw.path>)
      expect(response.status).toBe(404)
    })
  })

  describe('plain buffer', () => {
    it('strips ANSI escapes and recomputes byte length', async () => {
      spyOn(manager, 'getRawBuffer').mockReturnValue({
        raw: '\u001b[31mred\u001b[0m',
        byteLength: 12,
        offset: 0,
      })
      const response = getPlainBuffer({
        params: { id: 'pty_web' },
      } as unknown as BunRequest<typeof routes.session.buffer.plain.path>)

      const body = (await response.json()) as { plain: string; byteLength: number }
      expect(body.plain).toBe('red')
      expect(body.byteLength).toBe(3)
    })

    it('returns 404 when the session is gone', async () => {
      spyOn(manager, 'getRawBuffer').mockReturnValue(null)
      const response = getPlainBuffer({
        params: { id: 'missing' },
      } as unknown as BunRequest<typeof routes.session.buffer.plain.path>)
      expect(response.status).toBe(404)
    })
  })
})

describe('handleUpgrade', () => {
  it('rejects non-websocket requests with 426', () => {
    const response = handleUpgrade({} as Bun.Server<undefined>, new Request('http://localhost/ws'))
    expect(response).toBeInstanceOf(Response)
    expect((response as Response).status).toBe(426)
  })

  it('returns undefined when the upgrade succeeds', () => {
    const server = {
      upgrade: () => true,
    } as unknown as Bun.Server<undefined>
    const request = new Request('http://localhost/ws', {
      headers: { upgrade: 'websocket' },
    })

    expect(handleUpgrade(server, request)).toBeUndefined()
  })

  it('returns 400 when the upgrade fails', () => {
    const server = {
      upgrade: () => false,
    } as unknown as Bun.Server<undefined>
    const request = new Request('http://localhost/ws', {
      headers: { upgrade: 'websocket' },
    })

    const response = handleUpgrade(server, request) as Response
    expect(response.status).toBe(400)
  })
})
