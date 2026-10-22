/**
 * The completion signal of a route.
 *
 * On MCP the wait is the signal: there is no conversation to wake, so the model
 * asks again. That only works if the wait ANSWERS - a wait that the transport
 * cuts is a wait that says nothing about the session it was waiting for.
 */

import { afterAll, afterEach, describe, expect, it } from 'bun:test'
import { DEFAULT_REQUEST_TIMEOUT_MSEC } from '@modelcontextprotocol/sdk/shared/protocol.js'

import { MCP_WAIT_CAP_SECONDS } from '../src/mcp/index.ts'
import { manager } from '../src/plugin/pty/manager.ts'
import { setWaitPolicy } from '../src/plugin/pty/wait-policy.ts'
import { ptyWait } from '../src/plugin/pty/tools/wait.ts'

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

function text(result: unknown): string {
  if (typeof result === 'string') return result
  throw new Error(`unexpected tool result: ${JSON.stringify(result).slice(0, 200)}`)
}

describe('the wait of a route', () => {
  const spawned: string[] = []

  afterAll(() => {
    for (const id of spawned) manager.kill(id, true)
    manager.clearAllSessions()
  })

  afterEach(() => {
    // The OpenCode route's policy: no cap, no heartbeat.
    setWaitPolicy({})
  })

  it('caps the wait below the transport limit', () => {
    // The MCP SDK cuts a request after 60 s. A wait that is cut is a tool error
    // instead of a <pty_wait_timeout>, and the model learns nothing.
    expect(MCP_WAIT_CAP_SECONDS * 1000).toBeLessThan(DEFAULT_REQUEST_TIMEOUT_MSEC)
  })

  it('answers with a timeout instead of waiting forever', async () => {
    const info = manager.spawn({
      command: 'sleep',
      args: ['30'],
      description: 'a session that runs on',
      parentSessionId: 'wait-test',
      cols: 80,
      rows: 24,
    })
    spawned.push(info.id)

    setWaitPolicy({ maxSeconds: 1 })
    const result = text(await ptyWait.execute({ id: info.id }, ctx))

    expect(result).toContain('<pty_wait_timeout')
  })

  it('answers with the exit once the session is over', async () => {
    const info = manager.spawn({
      command: 'bash',
      args: ['-c', 'printf "done\\r\\n"; exit 3'],
      description: 'a session that ends',
      parentSessionId: 'wait-test',
      cols: 80,
      rows: 24,
    })
    spawned.push(info.id)
    await new Promise((resolve) => setTimeout(resolve, 500))

    setWaitPolicy({ maxSeconds: 5 })
    const result = text(await ptyWait.execute({ id: info.id }, ctx))

    expect(result).toContain('<pty_waited')
    expect(result).toContain('Exit: 3')
  })

  it('keeps the OpenCode route unbounded', async () => {
    // The plugin path blocks until the session ends, and the conversation carries
    // the answer. A cap here would change what the plugin has always done.
    const info = manager.spawn({
      command: 'sleep',
      args: ['30'],
      description: 'a session that runs on',
      parentSessionId: 'wait-test',
      cols: 80,
      rows: 24,
    })
    spawned.push(info.id)

    // No policy, no cap: the wait is still waiting when the test looks.
    let settled = false
    const waiting = ptyWait.execute({ id: info.id }, ctx).then((result) => {
      settled = true
      return result
    })
    await new Promise((resolve) => setTimeout(resolve, 800))
    expect(settled).toBe(false)

    // And it ends when the session does.
    manager.kill(info.id, false)
    const result = text(await waiting)
    expect(result).toContain('<pty_waited')
  })

  it('tells the route that the wait is still running', async () => {
    const info = manager.spawn({
      command: 'sleep',
      args: ['30'],
      description: 'a session that runs on',
      parentSessionId: 'wait-test',
      cols: 80,
      rows: 24,
    })
    spawned.push(info.id)

    let beats = 0
    setWaitPolicy({
      maxSeconds: 2,
      heartbeatMs: 100,
      heartbeat: () => {
        beats += 1
      },
    })
    await ptyWait.execute({ id: info.id }, ctx)

    // The heartbeat is what keeps a transport's idle window open, and it only
    // runs while the wait runs.
    expect(beats).toBeGreaterThan(0)
  })
})
