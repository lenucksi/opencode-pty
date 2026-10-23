import { Rpc } from '@opencode/plugin/rpc'

import type { Notice, NoticeVariant } from '../shared/notice.ts'
import type { PTYServer } from '../web/server/server.ts'

export type { Notice, NoticeVariant } from '../shared/notice.ts'

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
    /**
     * Roll the daemon.
     *
     * The daemon is machine state and the machine is shared: every opencode
     * instance on it talks to the same socket. So the restart is the server half's
     * job - it is the half that owns the client - and a surface that wants it asks
     * for it here. It ends every session the daemon owns, which is the point of a
     * restart: the PTY masters belong to that process.
     */
    restartDaemon: {
      input: {
        type: 'object',
        properties: {
          /**
           * Who asked.
           *
           * The notice the roll sends out carries this, so the surface that
           * started it can recognise its own and stay quiet - it already showed
           * the answer.
           */
          actionId: { type: 'string' },
        },
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: {
          oldPid: { type: 'number' },
          newPid: { type: 'number' },
          restarted: { type: 'boolean' },
        },
        required: ['oldPid', 'newPid', 'restarted'],
        additionalProperties: false,
      },
      errors: {
        failed: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
    /**
     * Which process is the daemon, for a surface that shows it.
     *
     * `0` is "there is no daemon", not an error: the PTY service runs in-process
     * when nobody asked for a daemon, so a machine without one is a working
     * machine. The line that shows the pid says nothing rather than "not running".
     */
    daemonStatus: {
      input: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        type: 'object',
        properties: { pid: { type: 'number' } },
        required: ['pid'],
        additionalProperties: false,
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
          origin: { type: 'string' },
        },
        required: ['message', 'variant'],
        additionalProperties: false,
      },
    },
  },
})

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
export function notifyUser(
  message: string,
  variant: NoticeVariant = 'info',
  origin?: string
): void {
  try {
    emitter?.(origin === undefined ? { message, variant } : { message, variant, origin })
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
  const record = data as { message?: unknown; variant?: unknown; origin?: unknown }
  if (typeof record.message !== 'string' || record.message === '') return null
  const variant = record.variant
  const known: readonly NoticeVariant[] = ['info', 'success', 'warning', 'error']
  const origin =
    typeof record.origin === 'string' && record.origin !== '' ? record.origin : undefined
  return {
    message: record.message,
    variant: known.includes(variant as NoticeVariant) ? (variant as NoticeVariant) : 'info',
    ...(origin === undefined ? {} : { origin }),
  }
}

/** What a roll of the daemon answered. */
export interface DaemonRestart {
  readonly restarted: boolean
  readonly oldPid: number | null
  readonly newPid: number | null
}

/**
 * What a roll answered, or null when it is not an answer.
 *
 * The answer crosses a process boundary, so it is checked rather than trusted: a
 * malformed answer is no answer, and the surface that asked says so.
 */
export function daemonRestartFromData(data: unknown): DaemonRestart | null {
  if (typeof data !== 'object' || data === null) return null
  const record = data as { restarted?: unknown; oldPid?: unknown; newPid?: unknown }
  const pid = (value: unknown): number | null =>
    typeof value === 'number' && value > 0 ? value : null
  return {
    restarted: record.restarted === true,
    oldPid: pid(record.oldPid),
    newPid: pid(record.newPid),
  }
}

/**
 * Which daemon the server reports, or null when it does not say.
 *
 * A pid of `0` is the server's way of saying "nobody runs one" - the PTY service
 * works in-process - so it is an answer, not a failure, and the surface that asked
 * draws a line without a pid rather than claiming there is no service.
 */
export function daemonStatusFromData(data: unknown): number | null {
  if (typeof data !== 'object' || data === null) return null
  const pid = (data as { pid?: unknown }).pid
  return typeof pid === 'number' && pid > 0 ? pid : null
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
