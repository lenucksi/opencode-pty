import { Rpc } from '@opencode/plugin/rpc'

import type { PTYServer } from '../web/server/server.ts'

/**
 * The one thing this plugin's two halves have to say to each other.
 *
 * The TUI half cannot derive where the server half listens. A single `opencode serve --service`
 * hosts the plugin for every project the user opens, so the origin record is filed under the
 * directory THAT process was started in - a directory no panel can compute from its own session.
 * Measured on the author's machine: the record said `/var/home/j` while the panel sat in
 * `.../homelab/openwrt-installer-lab`, and the panel read "not running" beside a server that
 * answered `/health` with 376 sessions.
 *
 * Asking is exact: the answer is read off the live server object, so it cannot be stale, it needs
 * no project key, and it is right whether the port was explicit or OS-assigned.
 *
 * `not_running` is an expected answer rather than a failure. The panel must never start a server
 * on a load path, so a host with none says so and the panel keeps offering the click that does.
 */
export const PtyServerRpc = Rpc.define({
  id: 'opencode-pty',
  methods: {
    origin: {
      // Takes nothing, and says so rather than leaving it out: the type requires an input schema.
      input: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
        additionalProperties: false,
      },
      errors: {
        not_running: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
  },
  events: {},
})

/**
 * The address the running server reports, or null when there is none.
 *
 * Pure and separate from the registration so it can be tested against a real server: the RPC
 * method itself is a closure over the plugin's module state.
 */
export function serverOrigin(server: PTYServer | null): string | null {
  return server === null ? null : server.server.url.origin
}
