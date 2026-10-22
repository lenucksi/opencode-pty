/**
 * The MCP server's library.
 *
 * The server, the gate of this route and the way a route waits. The entry point
 * that puts them on a stdio transport is `entry.ts`, because a process that only
 * ever runs as a process cannot be measured by a test that imports it.
 */

import type { Server } from '@modelcontextprotocol/sdk/server/index.js'

import { PolicyAuthorizer } from '../plugin/pty/policy-authorizer.ts'
import { setPermissionAuthorizer } from '../plugin/pty/permissions.ts'
import { setToolRoute } from '../plugin/pty/tools/description.ts'
import { setWaitPolicy } from '../plugin/pty/wait-policy.ts'

export { createMcpServer, serverContext, serverSessionId, toolList } from './server.ts'

/**
 * How long a wait may take on this route.
 *
 * Below the transport's own request timeout: a call that is cut is a call that
 * says nothing about the session it was waiting for. The model asks again - a
 * wait is a poll, and a poll that was cut is a poll that said nothing.
 */
export const MCP_WAIT_CAP_SECONDS = 50

/**
 * The gate of this route.
 *
 * A foreign harness has no host to ask, so the policy answers - and the policy of
 * a route like this one refuses what nobody allowed. The user said yes to the
 * *tool* by configuring this server; they did not say yes to every command it can
 * start.
 */
export function installPolicy(): void {
  setPermissionAuthorizer(new PolicyAuthorizer({ defaultEffect: 'deny' }))
}

/**
 * The route this process serves.
 *
 * The texts are written for the route: this one has no conversation to deliver
 * an exit into, and its texts have to say so.
 */
export function installRoute(): void {
  setToolRoute('mcp')
}

/**
 * How a wait talks to the transport.
 *
 * A transport that cuts a call that says nothing cuts a wait of a minute. The
 * progress notification is what keeps the line open, and it needs the token of
 * the call in flight - which is why the route puts it in the tool's context.
 */
export function installWaitPolicy(server: Server): void {
  setWaitPolicy({
    maxSeconds: MCP_WAIT_CAP_SECONDS,
    heartbeat: (elapsedMs, progressToken) => {
      if (progressToken === undefined) return
      void server
        .notification({
          method: 'notifications/progress',
          params: {
            progressToken,
            progress: Math.floor(elapsedMs / 1000),
            message: 'still waiting for the session to end',
          },
        })
        .catch(() => {
          // A heartbeat that cannot be delivered is not a failure of the wait.
        })
    },
  })
}
