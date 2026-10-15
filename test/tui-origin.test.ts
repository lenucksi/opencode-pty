import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Plugin } from '@opencode/plugin/tui'

import { manager } from '../src/plugin/pty/manager.ts'
import { writeOrigin } from '../src/shared/runtime.ts'
import { createOriginFinder, originFromRpcAnswer, projectKeys } from '../src/tui/origin.ts'
import { PTYServer } from '../src/web/server/server.ts'

/**
 * How the panel finds its server, and why the order is what it is.
 *
 * The chain exists because the origin record is filed under a project key that cannot always be
 * derived: one long-lived `opencode serve --service` hosts the plugin for every project, so the
 * record sits under the directory THAT process was started in. Asking the server half over RPC
 * needs no key at all, which is why it is tried first.
 */

let runtimeDir: string
let project: string
let previousRuntimeDir: string | undefined
let server: PTYServer | null = null

beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), 'pty-tui-origin-runtime-'))
  // realpathSync: records are keyed on the canonical path, and /var is a symlink on some hosts.
  project = realpathSync(mkdtempSync(join(tmpdir(), 'pty-tui-origin-project-')))
  previousRuntimeDir = process.env.PTY_RUNTIME_DIR
  process.env.PTY_RUNTIME_DIR = runtimeDir
})

afterEach(() => {
  manager.clearAllSessions()
  server?.[Symbol.dispose]()
  server = null
  if (previousRuntimeDir === undefined) delete process.env.PTY_RUNTIME_DIR
  else process.env.PTY_RUNTIME_DIR = previousRuntimeDir
  rmSync(runtimeDir, { recursive: true, force: true })
  rmSync(project, { recursive: true, force: true })
})

/** A host client that records what the finder asked it to do. */
function fakeClient(over: { command?: () => Promise<void>; failCreate?: Error } = {}) {
  const calls: string[] = []
  const client = {
    session: {
      create: async (): Promise<{ id: string }> => {
        calls.push('create')
        if (over.failCreate) throw over.failCreate
        return { id: 'scratch-session' }
      },
      command: async (): Promise<void> => {
        calls.push('command')
        if (over.command) await over.command()
      },
      remove: async (): Promise<void> => {
        calls.push('remove')
      },
    },
  }
  return { client: client as unknown as Plugin.Context['client'], calls }
}

function finder(over: {
  ask?: () => Promise<unknown>
  keys?: () => string[]
  client?: Plugin.Context['client']
  onStartError?: (error: unknown) => void
  events?: string[]
}) {
  return createOriginFinder({
    client: over.client ?? fakeClient().client,
    ask: over.ask ?? (() => Promise.reject(new Error('no RPC on this host'))),
    keys: over.keys ?? (() => [project]),
    onStartError: over.onStartError ?? (() => {}),
    debug: (event) => over.events?.push(event),
    // No sleeps: the bootstrap's poll is bounded by attempts, not by the clock.
    sleep: async () => {},
  })
}

describe('originFromRpcAnswer', () => {
  it('takes the url out of the answer', () => {
    expect(originFromRpcAnswer({ url: 'http://127.0.0.1:4200' })).toBe('http://127.0.0.1:4200')
  })

  // A JSON Schema types the answer as `unknown` in TypeScript, and it crosses a process boundary:
  // anything that is not the promised shape has to read as "no answer" rather than reaching a
  // fetch as `undefined`.
  it('reads anything unexpected as no answer', () => {
    expect(originFromRpcAnswer(undefined)).toBeNull()
    expect(originFromRpcAnswer(null)).toBeNull()
    expect(originFromRpcAnswer('http://127.0.0.1:4200')).toBeNull()
    expect(originFromRpcAnswer({})).toBeNull()
    expect(originFromRpcAnswer({ url: '' })).toBeNull()
    expect(originFromRpcAnswer({ url: 4200 })).toBeNull()
  })
})

describe('projectKeys', () => {
  it('asks for the session first and the app default second', () => {
    expect(projectKeys('/work/app', '/home/j')).toEqual(['/work/app', '/home/j'])
  })

  // A session inside the app's own directory has one key, not the same one twice.
  it('does not repeat a default that is also the session', () => {
    expect(projectKeys('/work/app', '/work/app')).toEqual(['/work/app'])
  })

  // Nothing is written without a key, so there is nothing to find under an empty one.
  it('drops what names nothing', () => {
    expect(projectKeys(undefined, undefined)).toEqual([])
    expect(projectKeys('', undefined)).toEqual([])
    expect(projectKeys(undefined, '/home/j')).toEqual(['/home/j'])
  })
})

describe('createOriginFinder', () => {
  it('takes the server half\u2019s answer first, without looking at any record', async () => {
    const events: string[] = []
    const found = await finder({
      ask: async () => ({ url: 'http://127.0.0.1:1' }),
      // No key at all: the RPC answer needs none, which is the whole point of asking.
      keys: () => [],
      events,
    }).find(false)

    expect(found).toBe('http://127.0.0.1:1')
    expect(events).not.toContain('origin.unattributed')
  })

  it('falls back to the record under a project key', async () => {
    server = await PTYServer.createServer({ hostname: '127.0.0.1', directory: project })
    const found = await finder({}).find(false)
    expect(found).toBe(`http://127.0.0.1:${server.server.port}`)
  })

  // The measured failure this exists for: the record is filed under a directory the panel cannot
  // name, and there is exactly one server.
  it('takes any healthy record when no key matches, and says so', async () => {
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'pty-tui-origin-elsewhere-')))
    server = await PTYServer.createServer({ hostname: '127.0.0.1', directory: elsewhere })
    const events: string[] = []
    try {
      const found = await finder({ keys: () => [project], events }).find(false)
      expect(found).toBe(`http://127.0.0.1:${server.server.port}`)
      expect(events).toContain('origin.unattributed')
    } finally {
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  it('finds nothing, rather than starting something, when it may not start', async () => {
    const { client, calls } = fakeClient()
    expect(await finder({ client, keys: () => [] }).find(false)).toBeNull()
    expect(calls).toEqual([])
  })

  // Starting creates and deletes a session, so it happens only for the caller the user asked.
  it('starts one through the plugin\u2019s own command when allowed, and drops the scratch session', async () => {
    // No directory: the server itself publishes nothing, so only the bootstrap can produce a
    // record - which is what makes this a test of the bootstrap.
    server = await PTYServer.createServer({ hostname: '127.0.0.1' })
    const port = server.server.port
    if (typeof port !== 'number') throw new Error('the server bound no port')
    const { client, calls } = fakeClient({
      command: async () => {
        writeOrigin({ directory: project, hostname: '127.0.0.1', port })
      },
    })

    const found = await finder({ client }).find(true)

    expect(found).toBe(`http://127.0.0.1:${port}`)
    expect(calls).toEqual(['create', 'command', 'remove'])
  })

  it('names the cause instead of inviting another try when the start fails', async () => {
    const failure = new Error('no session for you')
    const { client, calls } = fakeClient({ failCreate: failure })
    const seen: unknown[] = []

    expect(await finder({ client, onStartError: (e) => seen.push(e) }).find(true)).toBeNull()
    expect(seen).toEqual([failure])
    // The scratch session is dropped even on the failure path, so a broken host does not
    // accumulate rows.
    expect(calls).toEqual(['create'])
  })
})
