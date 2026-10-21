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
  events: {
    /**
     * Something the reader should see.
     *
     * A slash command's result is `void` in the host's contract - the command runs and
     * whatever it returned is dropped - so a command that works looks exactly like a
     * command that did nothing. This is how the server half says what it did, and the
     * TUI half turns it into a toast.
     */
    notice: {
      schema: {
        type: 'object',
        properties: {
          message: { type: 'string' },
          variant: { type: 'string' },
        },
        required: ['message', 'variant'],
        additionalProperties: false,
      },
    },
  },
})

/** How a notice is dressed. The four the toast API knows. */
export type NoticeVariant = 'info' | 'success' | 'warning' | 'error'

/** One thing to tell the reader. */
export interface Notice {
  readonly message: string
  readonly variant: NoticeVariant
}

type NoticeEmitter = (notice: Notice) => void

let emitter: NoticeEmitter | null = null

/**
 * Install the channel a notice goes out on.
 *
 * A module-level slot, because the two halves are two processes that meet at the
 * plugin's RPC registration: the server half installs the emitter when it registers,
 * and the command handlers use it without knowing whether a TUI is listening.
 */
export function setNoticeEmitter(next: NoticeEmitter | null): void {
  emitter = next
}

/**
 * Say something in the reader's face.
 *
 * Best effort on purpose: a notice is never the point of the action that caused it,
 * and a channel that is not there must not fail the action.
 */
export function notifyUser(message: string, variant: NoticeVariant = 'info'): void {
  try {
    emitter?.({ message, variant })
  } catch {
    /* a notice that cannot be delivered is not a failure of the action */
  }
}

/**
 * A notice out of whatever arrived, or null when it is not one.
 *
 * The data crosses a process boundary, so it is checked rather than trusted: a
 * malformed notice is dropped, not shown as "[object Object]".
 */
export function noticeFromData(data: unknown): Notice | null {
  if (typeof data !== 'object' || data === null) return null
  const record = data as { message?: unknown; variant?: unknown }
  if (typeof record.message !== 'string' || record.message === '') return null
  const variant = record.variant
  const known: readonly NoticeVariant[] = ['info', 'success', 'warning', 'error']
  return {
    message: record.message,
    variant: known.includes(variant as NoticeVariant) ? (variant as NoticeVariant) : 'info',
  }
}

/**
 * The address the running server reports, or null when there is none.
 *
 * Pure and separate from the registration so it can be tested against a real server: the RPC
 * method itself is a closure over the plugin's module state.
 */
export function serverOrigin(server: PTYServer | null): string | null {
  return server === null ? null : server.server.url.origin
}
