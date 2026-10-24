#!/usr/bin/env bun
/**
 * The MCP server's entry point.
 *
 * A harness launches this and talks to it over stdio. The startup does three
 * things and nothing else: it says which route it is, it connects to the daemon
 * (starting it if the machine has none), and it serves the tools.
 *
 * stdout belongs to the protocol. Every line on it is a JSON-RPC message, because
 * a harness parses that stream and nothing else - a stray line is a broken
 * session, not a log line. The log goes to its own file, and what has to reach
 * the console goes to stderr.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { connectToDaemon } from '../plugin/pty/manager.ts'
import { createMcpServer, installPolicy, installRoute, installWaitPolicy } from './index.ts'
import { type Harness, edgesFor, installPlan, writeOpencodeEdge } from './install.ts'

/**
 * `agentterm-mcp install ...` - print (or write) how a harness reaches this package.
 *
 * Handled before the server starts, because it is not a server: it prints to stdout
 * and exits. Returns the exit code.
 */
export function runInstall(argv: readonly string[]): number {
  const write = argv.includes('--write')
  const harnessArg = argv.find((arg) => arg.startsWith('--harness='))?.slice('--harness='.length)
  const harness = (harnessArg ?? 'all') as Harness | 'all'
  const known: readonly string[] = ['opencode', 'claude', 'codex', 'generic', 'all']
  if (!known.includes(harness)) {
    console.error(`Unknown --harness '${harness}'. Known: ${known.join(', ')}.`)
    return 2
  }

  const home = process.env.HOME
  if (home === undefined || home === '') {
    console.error('HOME is not set, so there is no config directory to name.')
    return 2
  }
  const env = {
    home,
    ...(process.env.XDG_CONFIG_HOME ? { xdgConfigHome: process.env.XDG_CONFIG_HOME } : {}),
  }
  const edges = edgesFor(installPlan(env), harness)

  for (const edge of edges) {
    console.log(`\n# ${edge.title}`)
    console.log(edge.snippet)
    if (edge.note !== undefined) console.log(`# ${edge.note}`)
    if (write && edge.harness === 'opencode') {
      const result = writeOpencodeEdge(env)
      console.log(
        `# written to ${result.path}${result.backup === null ? '' : ` (backup: ${result.backup})`}`
      )
    }
  }
  if (!write) {
    console.log('\n# Nothing was written. Re-run with --write to add the OpenCode entry;')
    console.log("# the other edges are printed because their files are the harness's to own.")
  }
  return 0
}

/**
 * Serve the tools over stdio.
 *
 * The daemon is connected first: a tool call that finds no daemon would start one
 * per call, and the sessions would not be shared with the other routes.
 */
export async function main(): Promise<void> {
  installRoute()
  installPolicy()
  const server = createMcpServer()
  installWaitPolicy(server)
  await connectToDaemon()
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

// The entry is a module with a side effect only when it is the program being run:
// the harness starts it, and the tests import the library instead.
if (import.meta.main) {
  const argv = process.argv.slice(2)
  if (argv[0] === 'install') {
    process.exit(runInstall(argv.slice(1)))
  }
  main().catch((error: unknown) => {
    // stderr, never stdout: the protocol owns that stream.
    console.error('[agentterm-mcp] failed to start:', error)
    process.exit(1)
  })
}
