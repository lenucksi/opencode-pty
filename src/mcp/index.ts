#!/usr/bin/env bun
/**
 * The MCP server's entry point.
 *
 * A harness launches this and talks to it over stdio. The startup does three
 * things and nothing else: it connects to the daemon (starting it if the machine
 * has none), it installs the gate of this route, and it serves the tools.
 *
 * stdout belongs to the protocol. Every line on it is a JSON-RPC message, because
 * a harness parses that stream and nothing else - a stray line is a broken
 * session, not a log line. The log goes to its own file, and what has to reach
 * the console goes to stderr.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { connectToDaemon } from '../plugin/pty/manager.ts'
import { PolicyAuthorizer } from '../plugin/pty/policy-authorizer.ts'
import { setPermissionAuthorizer } from '../plugin/pty/permissions.ts'
import { createMcpServer } from './server.ts'

export { createMcpServer, toolList } from './server.ts'

/**
 * The gate of this route.
 *
 * A foreign harness has no host to ask, so the policy answers - and the policy of
 * a route like this one refuses what nobody allowed. The user said yes to the
 * *tool* by configuring this server; they did not say yes to every command it can
 * start.
 */
function installPolicy(): void {
  setPermissionAuthorizer(new PolicyAuthorizer({ defaultEffect: 'deny' }))
}

/**
 * Serve the tools over stdio.
 *
 * The daemon is connected first: a tool call that finds no daemon would start one
 * per call, and the sessions would not be shared with the other routes.
 */
export async function main(): Promise<void> {
  installPolicy()
  await connectToDaemon()
  const server = createMcpServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

// The entry is a module with a side effect only when it is the program being run:
// the harness starts it, and the tests import the server instead.
if (import.meta.main) {
  main().catch((error: unknown) => {
    // stderr, never stdout: the protocol owns that stream.
    console.error('[opencode-pty-mcp] failed to start:', error)
    process.exit(1)
  })
}
