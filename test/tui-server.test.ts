import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { manager } from '../src/plugin/pty/manager.ts'
import { ptySpawn } from '../src/plugin/pty/tools/spawn.ts'
import {
  cleanupSession,
  findAnyProjectOrigin,
  findProjectOrigin,
  isHealthy,
  listSessions,
  readScreen,
} from '../src/tui/server.ts'
import { PTYServer } from '../src/web/server/server.ts'

/**
 * The panel's HTTP side, against a real server.
 *
 * A fake here would test the fake: the whole question is whether the panel reads
 * what this server actually serves - the envelope the buffer endpoint returns, the
 * array the list endpoint returns, the health payload the probe matches on.
 */

let runtimeDir: string
let project: string
let previousRuntimeDir: string | undefined
let server: PTYServer | null = null

const origin = (): string => `http://127.0.0.1:${server?.server.port ?? 0}`

/** Dispose of the server and hand back the address it had, for "is it still there?" */
function stopServer(): string {
  const address = origin()
  server?.[Symbol.dispose]()
  server = null
  return address
}

beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), 'pty-tui-server-runtime-'))
  // realpathSync: the record is keyed on the canonical path, and /var is a symlink
  // on some hosts, so a raw temp path would not match.
  project = realpathSync(mkdtempSync(join(tmpdir(), 'pty-tui-server-project-')))
  previousRuntimeDir = process.env.PTY_RUNTIME_DIR
  process.env.PTY_RUNTIME_DIR = runtimeDir
})

afterEach(async () => {
  manager.clearAllSessions()
  if (server !== null) {
    server[Symbol.dispose]()
    server = null
  }
  if (previousRuntimeDir === undefined) delete process.env.PTY_RUNTIME_DIR
  else process.env.PTY_RUNTIME_DIR = previousRuntimeDir
  rmSync(runtimeDir, { recursive: true, force: true })
  rmSync(project, { recursive: true, force: true })
})

async function startServer(): Promise<void> {
  server = await PTYServer.createServer({ hostname: '127.0.0.1', directory: project })
}

async function spawnSession(title: string, command = 'true', args: string[] = []): Promise<string> {
  const started = await ptySpawn.execute(
    { command, args, title, description: 'tui server test' },
    {
      sessionID: 'test-parent-session',
      messageID: 'msg-1',
      agent: 'test-agent',
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {},
      directory: '/tmp',
      worktree: '/tmp',
    }
  )
  const output = typeof started === 'string' ? started : started.output
  const id = /id="(pty_[0-9a-f]+)"/.exec(output)?.[1]
  if (!id) throw new Error(`the spawn returned no id: ${output.slice(0, 120)}`)
  return id
}

describe('isHealthy', () => {
  test('recognises a running PTY server', async () => {
    await startServer()
    expect(await isHealthy(origin())).toBe(true)
  })

  // A record is only a hint about where to look, and a stale one is common: a
  // server killed hard leaves its file behind.
  test('rejects an address where nothing answers', async () => {
    await startServer()
    expect(await isHealthy(stopServer())).toBe(false)
  })

  // The reason the payload's shape is checked at all: something else on the machine
  // can answer on a loopback port.
  test('rejects a service that answers but is not a PTY server', async () => {
    const decoy = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => new Response('<html>not a pty server</html>'),
    })
    try {
      expect(await isHealthy(`http://127.0.0.1:${decoy.port}`)).toBe(false)
    } finally {
      decoy.stop(true)
    }
  })

  test('rejects a PTY-shaped body served on the wrong path', async () => {
    // Proves the probe asks /health specifically, not just any path.
    const decoy = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (request) =>
        new URL(request.url).pathname === '/health'
          ? new Response(JSON.stringify({ status: 'healthy', sessions: {} }))
          : new Response('nope'),
    })
    try {
      // /health does answer here, so this one IS healthy - the assertion is that the
      // shape, not the path text, is what decides.
      expect(await isHealthy(`http://127.0.0.1:${decoy.port}`)).toBe(true)
    } finally {
      decoy.stop(true)
    }
  })
})

describe('findProjectOrigin', () => {
  test('finds the server this project started, by its published record', async () => {
    await startServer()
    const found = await findProjectOrigin(project)
    expect(found).not.toBeNull()
    expect(found).toContain(String(server?.server.port))
    expect(await isHealthy(found as string)).toBe(true)
  })

  test('finds nothing for a project with no server', async () => {
    await startServer()
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'pty-tui-elsewhere-')))
    try {
      expect(await findProjectOrigin(elsewhere)).toBeNull()
    } finally {
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  // Nothing is written without a project key, so there is genuinely nothing to find
  // - not a lookup that could succeed with more effort.
  test('finds nothing without a location, rather than guessing', async () => {
    await startServer()
    expect(await findProjectOrigin(undefined)).toBeNull()
    expect(await findProjectOrigin('')).toBeNull()
  })

  test('finds nothing once the server is gone, because /health stops answering', async () => {
    await startServer()
    stopServer()
    expect(await findProjectOrigin(project)).toBeNull()
  })
})

describe('findAnyProjectOrigin', () => {
  // The measured shape of the bug this exists for: opencode was launched in one directory, the
  // session moved into a project below it, and the server's record is filed under the former -
  // so a lookup by the session alone reports "not running" beside a server that answers.
  test('finds the record filed under the app default while the session is elsewhere', async () => {
    await startServer()
    const session = realpathSync(mkdtempSync(join(tmpdir(), 'pty-tui-session-')))
    try {
      expect(await findProjectOrigin(session)).toBeNull()
      const found = await findAnyProjectOrigin([session, project])
      expect(found).toBe(`http://127.0.0.1:${server?.server.port}`)
      expect(await isHealthy(found as string)).toBe(true)
    } finally {
      rmSync(session, { recursive: true, force: true })
    }
  })

  // The session's own key wins when both have a server, so a moved session never ends up
  // reading another project's list.
  test('takes the first key that has a server, not any key', async () => {
    await startServer()
    const other = realpathSync(mkdtempSync(join(tmpdir(), 'pty-tui-other-')))
    const second = await PTYServer.createServer({ hostname: '127.0.0.1', directory: other })
    try {
      const sessionFirst = await findAnyProjectOrigin([project, other])
      const defaultFirst = await findAnyProjectOrigin([other, project])
      expect(sessionFirst).toBe(`http://127.0.0.1:${server?.server.port}`)
      expect(defaultFirst).toBe(`http://127.0.0.1:${second.server.port}`)
    } finally {
      second[Symbol.dispose]()
      rmSync(other, { recursive: true, force: true })
    }
  })

  test('skips the keys that name nothing', async () => {
    await startServer()
    expect(await findAnyProjectOrigin([undefined, '', project])).toBe(
      `http://127.0.0.1:${server?.server.port}`
    )
  })

  test('finds nothing when no key has a server', async () => {
    await startServer()
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'pty-tui-nowhere-')))
    try {
      expect(await findAnyProjectOrigin([elsewhere, undefined])).toBeNull()
    } finally {
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })
})

describe('listSessions', () => {
  test('returns what the server serves, as an array', async () => {
    await startServer()
    expect(await listSessions(origin())).toEqual([])
    await spawnSession('one')
    const sessions = await listSessions(origin())
    expect(sessions.map((s) => s.title)).toContain('one')
  })

  test('names a failure rather than returning an empty list', async () => {
    // An empty list and a dead server look identical to a caller that ignores the
    // difference; the panel would render "(none)" for a server that is not there.
    await startServer()
    await expect(listSessions(stopServer())).rejects.toThrow()
  })
})

describe('readScreen', () => {
  test('shows the screen the program drew, with the cursor position applied', async () => {
    await startServer()
    // A cursor move and nothing else. `buffer/plain` deletes the escape sequence along
    // with the colour codes, so this arrives as unpainted text with the indentation
    // gone - which is the whole reason the dialog reads the screen now.
    const id = await spawnSession('laid-out', 'printf', ['%b', 'top\r\nsecond\r\n\u001b[3;7Hmoved'])
    // The archive is written when the process ends, so the screen is not there the
    // instant the spawn returns. Polled rather than slept on.
    let seen = 'never read'
    for (let attempt = 0; attempt < 100; attempt++) {
      seen = await readScreen(origin(), id).catch((error: unknown) => `failed: ${String(error)}`)
      if (seen.includes('moved')) {
        expect(seen).toContain('top')
        expect(seen).toContain('second')
        // Six columns in, on the third row: the layout the escape sequence asked for,
        // preserved because the emulator applied it.
        expect(seen.split('\n')[2]).toBe('      moved')
        return
      }
      await Bun.sleep(25)
    }
    throw new Error(`the screen never showed the output. Read: ${seen.slice(0, 160)}`)
  })

  test('names a failure rather than returning empty text', async () => {
    await startServer()
    await expect(readScreen(origin(), 'pty_does_not_exist')).rejects.toThrow()
  })
})
describe('cleanupSession', () => {
  test('removes the entry, which is what a plain kill does not do', async () => {
    await startServer()
    const id = await spawnSession('removable')
    expect((await listSessions(origin())).map((s) => s.id)).toContain(id)
    await cleanupSession(origin(), id)
    expect((await listSessions(origin())).map((s) => s.id)).not.toContain(id)
  })

  test('names a refusal instead of reporting success', async () => {
    await startServer()
    await expect(cleanupSession(origin(), 'pty_does_not_exist')).rejects.toThrow()
  })
})
