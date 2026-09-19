import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { apiFetch, apiFetchJson, createApiClient } from '../src/web/shared/api-client.ts'
import { routes } from '../src/web/shared/routes.ts'

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function installLocation(): void {
  Object.defineProperty(globalThis, 'location', {
    value: { protocol: 'https:', host: 'example.test' },
    configurable: true,
  })
}

afterEach(() => {
  mock.restore()
  Reflect.deleteProperty(globalThis, 'location')
})

describe('apiFetch', () => {
  it('builds a URL from path params and query values', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse([]))

    await apiFetch(routes.session.buffer.raw, {
      method: 'GET',
      params: { id: 'pty_123' },
      query: { since: 5 },
      baseUrl: 'http://localhost:4321',
    })

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://localhost:4321/api/sessions/pty_123/buffer/raw?since=5',
      expect.objectContaining({
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      })
    )
  })

  it('omits undefined query values and the trailing question mark', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse([]))

    await apiFetch(routes.sessions, {
      method: 'GET',
      query: { a: undefined, b: 2 },
      baseUrl: 'http://localhost:4321',
    })

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://localhost:4321/api/sessions?b=2',
      expect.anything()
    )
  })

  it('serializes the body for POST requests only', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}))

    await apiFetch(routes.session.input, {
      method: 'POST',
      params: { id: 'pty_1' },
      body: { data: 'hello' },
      baseUrl: 'http://localhost:4321',
    })

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://localhost:4321/api/sessions/pty_1/input')
    expect(init.body).toBe(JSON.stringify({ data: 'hello' }))
  })

  it('derives the base URL from location when none is provided', async () => {
    installLocation()
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}))

    await apiFetch(routes.health, { method: 'GET' })

    expect(fetchSpy).toHaveBeenCalledWith('https://example.test/health', expect.anything())
  })
})

describe('apiFetchJson', () => {
  it('parses the JSON payload', async () => {
    spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: true }))

    await expect(
      apiFetchJson<typeof routes.health, 'GET', { ok: boolean }>(routes.health, {
        method: 'GET',
        baseUrl: 'http://localhost:4321',
      })
    ).resolves.toEqual({ ok: true })
  })

  it('throws a descriptive error for non-2xx responses', async () => {
    spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('nope', { status: 500, statusText: 'Internal Server Error' })
    )

    await expect(
      apiFetchJson(routes.health, { method: 'GET', baseUrl: 'http://localhost:4321' })
    ).rejects.toThrow('API error: 500 Internal Server Error')
  })
})

describe('createApiClient', () => {
  it('covers every session, buffer and health method', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async () =>
      jsonResponse({ ok: true })) as unknown as typeof fetch)
    const client = createApiClient('http://localhost:4321')

    await client.sessions.list()
    await client.sessions.create({ command: 'echo', args: ['hi'] })
    await client.sessions.clear()
    await client.session.get({ id: 'pty_1' })
    await client.session.kill({ id: 'pty_1' })
    await client.session.input({ id: 'pty_1' }, { data: 'x' })
    await client.session.cleanup({ id: 'pty_1' })
    await client.session.buffer.raw({ id: 'pty_1' })
    await client.session.buffer.raw({ id: 'pty_1', since: 7 })
    await client.session.buffer.plain({ id: 'pty_1' })
    await client.health()

    const urls = fetchSpy.mock.calls.map((call) => call[0])
    expect(urls).toEqual([
      'http://localhost:4321/api/sessions',
      'http://localhost:4321/api/sessions',
      'http://localhost:4321/api/sessions',
      'http://localhost:4321/api/sessions/pty_1',
      'http://localhost:4321/api/sessions/pty_1',
      'http://localhost:4321/api/sessions/pty_1/input',
      'http://localhost:4321/api/sessions/pty_1/cleanup',
      'http://localhost:4321/api/sessions/pty_1/buffer/raw',
      'http://localhost:4321/api/sessions/pty_1/buffer/raw?since=7',
      'http://localhost:4321/api/sessions/pty_1/buffer/plain',
      'http://localhost:4321/health',
    ])

    const methods = fetchSpy.mock.calls.map((call) => (call[1] as RequestInit).method)
    expect(methods).toEqual([
      'GET',
      'POST',
      'DELETE',
      'GET',
      'DELETE',
      'POST',
      'DELETE',
      'GET',
      'GET',
      'GET',
      'GET',
    ])
  })
})
