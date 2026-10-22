/**
 * The texts of the routes, and what they promise.
 *
 * The OpenCode route is told about the `<pty_exited>` message, because there is a
 * conversation to deliver it into. The MCP route is told that it has none, because
 * there is not - and a model that was told to expect a message and gets none
 * waits for nothing.
 */

import { afterEach, describe, expect, it } from 'bun:test'

import { ptyTools } from '../src/plugin/pty/tools/all.ts'
import {
  describeForRoute,
  getToolRoute,
  setToolRoute,
} from '../src/plugin/pty/tools/description.ts'
import { ptySpawn } from '../src/plugin/pty/tools/spawn.ts'

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

describe('the texts of a route', () => {
  afterEach(() => {
    setToolRoute('opencode')
  })

  it('leaves no hole in either text', () => {
    for (const [name, definition] of Object.entries(ptyTools)) {
      for (const route of ['opencode', 'mcp'] as const) {
        const described = describeForRoute(definition.description, route)
        expect(described).not.toContain('{{')
        expect(described.length).toBeGreaterThan(0)
        expect(name.length).toBeGreaterThan(0)
      }
    }
  })

  it('tells the OpenCode route about the exit message', () => {
    const described = describeForRoute(ptyTools.pty_spawn.description, 'opencode')
    expect(described).toContain('`<pty_exited>` message')
  })

  it('tells the MCP route that it has no exit message', () => {
    const described = describeForRoute(ptyTools.pty_spawn.description, 'mcp')
    expect(described).not.toContain('receive a `<pty_exited>` message')
    expect(described).toContain('no conversation to deliver a message into')
  })

  it('remembers the route it serves', () => {
    expect(getToolRoute()).toBe('opencode')
    setToolRoute('mcp')
    expect(getToolRoute()).toBe('mcp')
  })
})

describe('what notifyOnExit does on a route', () => {
  afterEach(() => {
    setToolRoute('opencode')
  })

  it('is a message on the OpenCode route', async () => {
    const result = await ptySpawn.execute(
      { command: 'echo', args: ['route-test'], description: 'route test', notifyOnExit: true },
      ctx
    )
    expect(result).toContain(
      'Completion signal for this session is the future `<pty_exited>` message'
    )
  })

  it('is nothing on the MCP route, and the result says so', async () => {
    setToolRoute('mcp')
    const result = await ptySpawn.execute(
      { command: 'echo', args: ['route-test'], description: 'route test', notifyOnExit: true },
      ctx
    )
    expect(result).toContain('has NO effect on this route')
    expect(result).toContain('`pty_wait`')
    expect(result).not.toContain('the future `<pty_exited>` message')
  })
})
