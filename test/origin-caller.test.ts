import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { originsForProject, runtimeDir } from '../src/shared/runtime.ts'
import { getOrCreateServer, stopActiveServer } from '../src/v2/commands.ts'

/**
 * The caller side of the origin record.
 *
 * The server publishes itself; that is only half of it. What makes the record
 * findable is the project key, and that comes from the plugin context - so a
 * server that starts with no directory publishes an address nobody can look up.
 * This is the part the upstream tests do not reach: they construct a server with
 * a directory by hand.
 */

let dir: string
let project: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pty-origin-caller-'))
  process.env.PTY_RUNTIME_DIR = dir
  // realpathSync: the record is keyed on the canonical path, and macOS puts
  // /var under a symlink, so a raw temp path would not match what is written.
  project = realpathSync(mkdtempSync(join(tmpdir(), 'pty-project-')))
  stopActiveServer()
})

afterEach(() => {
  stopActiveServer()
  delete process.env.PTY_RUNTIME_DIR
  rmSync(dir, { recursive: true, force: true })
  rmSync(project, { recursive: true, force: true })
})

describe('the V2 server start publishes a findable origin', () => {
  test('a project directory reaches the record, so a TUI can look it up', async () => {
    const server = await getOrCreateServer({ directory: project })

    const records = originsForProject(project)
    expect(records).toHaveLength(1)
    expect(records[0]?.port).toBe(server.server.port)
    // The directory the record is keyed on, not a temp path that happens to
    // match: the key is what a reader computes from its own session.
    expect(records[0]?.directory).toBe(project)
    expect(records[0]?.startedAt).toBeGreaterThan(0)
  })

  test('a server without a project path publishes no record at all', async () => {
    // Measured, and the reason is not "lookup fails": nothing is written. An
    // unkeyed record could not be attributed to an instance, and /api/server
    // reports no project either - so a probed candidate could not be told from
    // another instance's. Invisibility is the honest outcome, and it is why the
    // V2 call site has to pass ctx.location.
    const server = await getOrCreateServer({ hostname: '127.0.0.1' })
    expect(server.server.port).toBeGreaterThan(0)

    const { readOrigins } = await import('../src/shared/runtime.ts')
    expect(originsForProject(project)).toEqual([])
    expect(readOrigins().some((record) => record.port === server.server.port)).toBe(false)
  })

  test('two servers for two projects are told apart', async () => {
    const other = realpathSync(mkdtempSync(join(tmpdir(), 'pty-project-b-')))
    try {
      const first = await getOrCreateServer({ directory: project })
      // A second, independent server - the first is cached by getOrCreateServer,
      // so this uses createServer directly to get a real second record.
      const { PTYServer } = await import('../src/web/server/server.ts')
      const second = await PTYServer.createServer({ directory: other })
      try {
        const firstPort = first.server.port
        const secondPort = second.server.port
        if (firstPort === undefined || secondPort === undefined) {
          throw new Error('a bound server reported no port')
        }
        expect(originsForProject(project).map((r) => r.port)).toContain(firstPort)
        expect(originsForProject(other).map((r) => r.port)).toContain(secondPort)
        // The machine may have leftovers from other tests, but never one record
        // answering to two projects.
        expect(originsForProject(project)).toHaveLength(1)
        expect(originsForProject(other)).toHaveLength(1)
      } finally {
        second[Symbol.dispose]()
      }
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })

  test('disposing the server removes its record, so the directory cannot grow', async () => {
    await getOrCreateServer({ directory: project })
    expect(originsForProject(project)).toHaveLength(1)

    stopActiveServer()

    expect(originsForProject(project)).toEqual([])
    expect(runtimeDir()).toBe(dir)
  })
})
