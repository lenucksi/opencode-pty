/**
 * The MCP server, driven by a real MCP client.
 *
 * Not by our own dispatcher: a protocol mistake is exactly what this is here to
 * catch, and a test that talks to the server the way a harness does is the only
 * one that catches it.
 *
 * The server runs in its own process with its own runtime directory, its own state
 * directory and its own configuration - so it starts its own daemon, exactly as it
 * would on a machine without OpenCode.
 */

import { afterAll, describe, expect, it } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createMcpServer,
  installPolicy,
  installRoute,
  installWaitPolicy,
} from '../src/mcp/index.ts'
import { setPermissionAuthorizer } from '../src/plugin/pty/permissions.ts'
import { setToolRoute } from '../src/plugin/pty/tools/description.ts'
import { getWaitPolicy, setWaitPolicy } from '../src/plugin/pty/wait-policy.ts'

const TOOLS = [
  'pty_spawn',
  'pty_write',
  'pty_read',
  'pty_list',
  'pty_kill',
  'pty_wait',
  'pty_resize',
  'pty_screen',
]

const temps: string[] = []

afterAll(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * A machine of its own: a runtime directory for the daemon's socket, a state
 * directory for its sessions, and a configuration that says what may run.
 */
function machine(): { runtimeDir: string; stateDir: string; configHome: string } {
  const root = mkdtempSync(join(tmpdir(), 'opencode-pty-mcp-'))
  temps.push(root)
  const runtimeDir = join(root, 'run')
  const stateDir = join(root, 'state')
  const configHome = join(root, 'config')
  mkdirSync(runtimeDir, { recursive: true })
  mkdirSync(stateDir, { recursive: true })
  mkdirSync(join(configHome, 'opencode'), { recursive: true })
  // The route's policy: this harness may start what it asks for. The default of
  // the route is to refuse, and a test that did not say otherwise would be
  // testing the refusal.
  writeFileSync(
    join(configHome, 'opencode', 'opencode.json'),
    JSON.stringify({ permission: { bash: { '*': 'allow' } } })
  )
  return { runtimeDir, stateDir, configHome }
}

function serverEnv(m: ReturnType<typeof machine>): Record<string, string> {
  const inherited: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) inherited[key] = value
  }
  return {
    ...inherited,
    XDG_RUNTIME_DIR: m.runtimeDir,
    XDG_STATE_HOME: m.stateDir,
    XDG_CONFIG_HOME: m.configHome,
    OPENCODE_PTY_STATE_DIR: join(m.stateDir, 'sessions'),
  }
}

async function withClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const m = machine()
  const transport = new StdioClientTransport({
    command: 'bun',
    args: ['src/mcp/entry.ts'],
    env: serverEnv(m),
    stderr: 'pipe',
  })
  const client = new Client({ name: 'test-harness', version: '1.0.0' })
  await client.connect(transport)
  try {
    return await run(client)
  } finally {
    await client.close()
  }
}

/** The server process, for the cases that need to read its stdout itself. */
function spawnServer(m: ReturnType<typeof machine>) {
  return Bun.spawn(['bun', 'src/mcp/entry.ts'], {
    env: serverEnv(m),
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
}

describe('the MCP server', () => {
  it('serves the tools in process, over a linked transport', async () => {
    // The same server the harness gets, without a process in between: the
    // dispatcher, the tool list and the prompt are all measured here.
    // What the route installs, in a process of its own.
    installRoute()
    installPolicy()
    const server = createMcpServer()
    installWaitPolicy(server)
    const client = new Client({ name: 'in-process', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
    try {
      const tools = await client.listTools()
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([...TOOLS].sort())

      const prompts = await client.listPrompts()
      expect(prompts.prompts.map((prompt) => prompt.name)).toContain('pty-usage')

      const unknown = await client.callTool({ name: 'pty_nonsense', arguments: {} })
      expect(unknown.isError).toBe(true)
      expect(String((unknown.content as { text?: string }[])[0]?.text ?? '')).toContain(
        'unknown tool'
      )

      // A call that goes through a tool: the dispatcher, the tool and the text
      // this route writes.
      const listed = await client.callTool({ name: 'pty_list', arguments: {} })
      const text = String((listed.content as { text?: string }[])[0]?.text ?? '')
      expect(text).toContain('<pty_list')

      // A call that fails is an answer, not a crash.
      const failed = await client.callTool({ name: 'pty_read', arguments: { id: 'pty_nope' } })
      expect(failed.isError).toBe(true)

      // The heartbeat: a transport that cuts a call that says nothing cuts a wait.
      getWaitPolicy().heartbeat?.(1000, 'token-1')
    } finally {
      setPermissionAuthorizer(null)
      setWaitPolicy({})
      setToolRoute('opencode')
      await client.close()
    }
  })

  it('offers the eight PTY tools, each with a schema of its own', async () => {
    const result = await withClient(async (client) => {
      const listed = await client.listTools()
      return listed.tools
    })

    expect(result.map((tool) => tool.name).sort()).toEqual([...TOOLS].sort())
    for (const tool of result) {
      expect(tool.description).toBeTruthy()
      expect(tool.inputSchema.type).toBe('object')
    }
  })

  it('starts a session that another client sees, and reads it back', async () => {
    const m = machine()
    const transport = new StdioClientTransport({
      command: 'bun',
      args: ['src/mcp/entry.ts'],
      env: serverEnv(m),
      stderr: 'pipe',
    })
    const client = new Client({ name: 'test-harness', version: '1.0.0' })
    await client.connect(transport)
    try {
      const spawned = await client.callTool({
        name: 'pty_spawn',
        arguments: { command: 'echo', args: ['from-mcp'], description: 'mcp session' },
      })
      const text = String((spawned.content as { text?: string }[])[0]?.text ?? '')
      expect(text).toContain('<pty_spawned')
      const id = text.match(/id="([^"]+)"/)?.[1]
      expect(id).toBeTruthy()

      // The very same session, seen from the other side of the socket: the daemon
      // owns it, so the MCP server and a client see one list.
      const { PtyClient } = await import('../src/client/pty-client.ts')
      const other = new PtyClient({
        socketPath: join(m.runtimeDir, 'opencode-pty', 'ptyd.sock'),
        stateDir: join(m.stateDir, 'sessions'),
      })
      await other.connect()
      const sessions = await other.list()
      expect(sessions.some((session) => session.id === id)).toBe(true)
      other.disconnect()

      const read = await client.callTool({
        name: 'pty_read',
        arguments: { id, limit: 20 },
      })
      expect(String((read.content as { text?: string }[])[0]?.text ?? '')).toContain('<pty_output')

      const screen = await client.callTool({ name: 'pty_screen', arguments: { id } })
      expect(String((screen.content as { text?: string }[])[0]?.text ?? '')).toContain(
        '<pty_screen'
      )

      await client.callTool({ name: 'pty_kill', arguments: { id, cleanup: true } })
    } finally {
      await client.close()
    }
  })

  it("offers the usage guide as a prompt, in this route's words", async () => {
    const result = await withClient(async (client) => {
      const prompts = await client.listPrompts()
      const prompt = await client.getPrompt({ name: 'pty-usage' })
      return { prompts: prompts.prompts, text: prompt.messages[0]?.content }
    })

    expect(result.prompts.map((prompt) => prompt.name)).toContain('pty-usage')
    const text = String((result.text as { text?: string } | undefined)?.text ?? '')
    expect(text).toContain('pty_wait')
    // The guide tells a model how to wait for an exit, and this route has no exit
    // message to wait for.
    expect(text).not.toContain('the future <pty_exited> message')
  })

  it('answers with an empty list on a machine with no sessions', async () => {
    const result = await withClient(async (client) => {
      const listed = await client.callTool({ name: 'pty_list', arguments: {} })
      return String((listed.content as { text?: string }[])[0]?.text ?? '')
    })

    expect(result).toContain('<pty_list')
  })

  it('refuses a command the policy does not allow', async () => {
    const m = machine()
    // A policy that says nothing: the route's default is to refuse.
    writeFileSync(
      join(m.configHome, 'opencode', 'opencode.json'),
      JSON.stringify({ permission: { bash: { 'rm -rf *': 'deny' } } })
    )
    const transport = new StdioClientTransport({
      command: 'bun',
      args: ['src/mcp/entry.ts'],
      env: serverEnv(m),
      stderr: 'pipe',
    })
    const client = new Client({ name: 'test-harness', version: '1.0.0' })
    await client.connect(transport)
    try {
      const refused = await client.callTool({
        name: 'pty_spawn',
        arguments: { command: 'rm', args: ['-rf', '/tmp/nothing'] },
      })
      const text = String((refused.content as { text?: string }[])[0]?.text ?? '')
      expect(text).toContain('denied by the permission policy')
    } finally {
      await client.close()
    }
  })

  // stdout is the protocol. A line that is not JSON-RPC is a broken session, and
  // the reconnect path used to write exactly such a line.
  it('keeps stdout pure JSON-RPC when the daemon dies and comes back', async () => {
    const m = machine()
    const server = spawnServer(m)
    const lines: string[] = []
    const reader = (async () => {
      const decoder = new TextDecoder()
      for await (const chunk of server.stdout) {
        for (const line of decoder.decode(chunk).split('\n')) {
          if (line.trim() !== '') lines.push(line)
        }
      }
    })()
    const errs: string[] = []
    const errReader = (async () => {
      const decoder = new TextDecoder()
      for await (const chunk of server.stderr) errs.push(decoder.decode(chunk))
    })()

    // The handshake, written by hand: the point of the case is what the server
    // writes, not what the SDK client does with it.
    const write = (message: unknown) => {
      server.stdin.write(`${JSON.stringify(message)}\n`)
      // Bun buffers what is written to a subprocess's stdin: without the flush the
      // server never sees the line.
      server.stdin.flush()
    }
    /** The answer to a request, once it has been written. */
    const answer = async (id: number): Promise<Record<string, unknown>> => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const found = lines
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .find((message) => message.id === id)
        if (found) return found
        await Bun.sleep(100)
      }
      throw new Error(
        `the server never answered request ${id}; stderr: ${errs.join('').slice(0, 800)}`
      )
    }

    write({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'raw-harness', version: '1.0.0' },
      },
    })
    await answer(1)
    write({ jsonrpc: '2.0', method: 'notifications/initialized' })
    write({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    await answer(2)

    // Now that the server is serving, the daemon dies under its feet. The client
    // reconnects - and the reconnect used to print a line to stdout.
    const pidFile = join(m.runtimeDir, 'opencode-pty', 'ptyd.pid')
    const pid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
    expect(Number.isSafeInteger(pid)).toBe(true)
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // Already gone.
    }

    // The client reconnects on its own; a call after that is answered normally.
    await Bun.sleep(2500)
    write({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'pty_list', arguments: {} },
    })
    await answer(3)
    server.kill()
    await reader.catch(() => {})
    await errReader.catch(() => {})

    expect(lines.length).toBeGreaterThan(2)
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow()
    }
  }, 30_000)
})
