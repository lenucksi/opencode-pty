#!/usr/bin/env bun
/**
 * The web interface on its own.
 *
 * The plugin starts the interface from inside OpenCode, and a harness that is not
 * OpenCode has no way to show a human what the sessions are doing. This binary is
 * that way: it serves the existing interface against the daemon and prints the
 * address, once, on stdout.
 *
 * The daemon is the state: the sessions, the archive and the generation live there,
 * and this is a view of it. So the binary starts nothing but the HTTP server, and
 * a machine with no daemon gets one started rather than an error.
 *
 * The permission gate is NOT installed on this path. The interface is a human's
 * own surface, and the host's rules are the host's business - but that also means
 * anything that can reach the port can start a process, which is why it binds to
 * the loopback address by default.
 */

import { connectToDaemon } from '../plugin/pty/manager.ts'
import { PTYServer } from './server/server.ts'

/**
 * Serve the interface and print its address.
 *
 * The address is printed once: a caller reads the line and opens it, and a
 * printed address that changes every second is a line nobody can copy.
 */
export async function main(): Promise<void> {
  await connectToDaemon()
  const server = await PTYServer.createServer({
    port: 0,
    hostname: process.env.PTY_WEB_HOSTNAME,
    directory: process.cwd(),
  })
  console.log(server.server.url.origin)

  // The origin record is removed when the server is disposed, so the TUI of a
  // running OpenCode does not point at a server that is gone.
  const stop = (): void => {
    server[Symbol.dispose]()
    process.exit(0)
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error('[opencode-pty-web] failed to start:', error)
    process.exit(1)
  })
}
