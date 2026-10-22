/**
 * The daemon's request handling: one handler per method.
 *
 * The table is the protocol: a method missing here answers `unknown method`, which
 * is the one place a client can tell that the daemon is older than the plugin. It
 * lives in its own file because it is a long list of short answers, and the daemon
 * itself is about being a daemon.
 */

import { manager } from '../plugin/pty/manager.ts'
import type { RetentionPolicy, SessionStore } from '../plugin/pty/session-store.ts'
import type { SpawnOptions } from '../plugin/pty/types.ts'
import { type DaemonRequest, type DaemonResponse, encodeMessage } from './protocol.ts'

/** What a handler needs of a connected client. */
export interface WireClient {
  socket: Bun.Socket<undefined>
  writer: { enqueue: (payload: string) => void }
  lastSeen: number
}

type WireParams = Record<string, unknown>
/**
 * A handler's answer.
 *
 * It may be a promise: the screen renderer is asynchronous, and a handler that
 * returned one without waiting for it would put the PROMISE on the wire - and
 * `JSON.stringify` turns a promise into `{}`.
 */
type RequestHandler = (
  params: WireParams,
  socket: Bun.Socket<undefined>
) => unknown | Promise<unknown>

/**
 * The dispatcher, with the table behind it.
 *
 * Every answer goes back through the client's queued writer, because a response can
 * exceed one socket buffer - the list of a few hundred sessions is about 350 kB.
 */
export function createRequestHandler(
  store: SessionStore,
  clients: Map<string, WireClient>
): (socket: Bun.Socket<undefined>, request: DaemonRequest) => void {
  const handlers: Record<string, RequestHandler> = {
    ping: () => ({ pong: true, generation: store.getGeneration(), pid: process.pid }),
    list: () => manager.list(),
    spawn: (params) => manager.spawn(spawnFrom(params)),
    write: (params) => ({ success: manager.write(params.id as string, params.data as string) }),
    read: (params) =>
      manager.read(
        params.id as string,
        params.offset as number,
        params.limit as number,
        params.budget as number
      ),
    kill: (params) => ({ success: manager.kill(params.id as string, params.cleanup as boolean) }),
    resize: (params) => ({
      success: manager.resize(params.id as string, params.cols as number, params.rows as number),
    }),
    heartbeat: (_params, socket) => {
      for (const client of clients.values()) {
        if (client.socket === socket) {
          client.lastSeen = Date.now()
          break
        }
      }
      return { ok: true }
    },
    search: (params) =>
      manager.search(
        params.id as string,
        new RegExp(params.pattern as string, params.ignoreCase ? 'i' : ''),
        (params.offset as number) ?? 0,
        params.limit as number,
        params.budget as number
      ),
    get: (params) => manager.get(params.id as string),
    get_session: (params) => manager.getSession(params.id as string),
    get_session_log: (params) =>
      manager.getSessionLog(params.id as string, { tail: params.tail as number }),
    describe_missing_session: (params) => manager.describeMissingSession(params.id as string),
    describe_server: () => manager.describeServer(),
    screen: (params) =>
      manager.screen(params.id as string, {
        cols: params.cols as number | undefined,
        rows: params.rows as number | undefined,
        scrollback: params.scrollback as number | undefined,
        chars: params.chars as number | undefined,
      }),
    get_raw_buffer: (params) => manager.getRawBuffer(params.id as string, params.since as number),
    read_since: (params) =>
      manager.readSince(params.id as string, params.since as number, params.budget as number),
    cleanup_by_session: (params) => {
      manager.cleanupBySession(params.parentSessionId as string)
      return { ok: true }
    },
    load_persisted_sessions: () => manager.loadPersistedSessions(),
    bulk_remove: (params) => manager.bulkRemove(params.ids as string[]),
    restore_sessions: (params) => manager.restoreSessions(params.ids as string[]),
    clear_all_sessions: () => {
      manager.clearAllSessions()
      return { ok: true }
    },
    note_client_size: (params) => {
      manager.noteClientSize(params.cols as number, params.rows as number)
      return { ok: true }
    },
    get_retention: () => ({ retention: store.getRetention() }),
    update_retention: (params) => ({
      pruned: store.updateRetention(params.policy as Partial<RetentionPolicy>),
    }),
    get_generation: () => ({ generation: store.getGeneration() }),
    get_state_dir: () => ({ stateDir: store.getRoot() }),
    list_persisted: () => store.list(),
    read_persisted: (params) =>
      store.read(params.id as string, params.offset as number, params.limit as number),
  }

  return async function handleRequest(socket: Bun.Socket<undefined>, request: DaemonRequest) {
    const handler = handlers[request.method]
    let result: unknown
    let error: string | undefined
    try {
      if (handler === undefined) error = `unknown method: ${request.method}`
      else result = await handler(request.params ?? {}, socket)
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught)
    }

    const response: DaemonResponse = { id: request.id }
    if (error) response.error = error
    else response.result = result
    const target = [...clients.values()].find((client) => client.socket === socket)
    if (target !== undefined) target.writer.enqueue(encodeMessage(response))
    else {
      try {
        socket.write(encodeMessage(response))
      } catch {
        // The peer is gone; nothing to report to.
      }
    }
  }
}

/** The wire carries JSON; this is the one place that says which fields a spawn needs. */
function spawnFrom(params: WireParams): SpawnOptions {
  const options: SpawnOptions = { command: params.command as string }
  if (params.parentSessionId !== undefined)
    options.parentSessionId = params.parentSessionId as string
  if (params.args !== undefined) options.args = params.args as string[]
  if (params.workdir !== undefined) options.workdir = params.workdir as string
  if (params.env !== undefined) options.env = params.env as Record<string, string>
  if (params.title !== undefined) options.title = params.title as string
  if (params.description !== undefined) options.description = params.description as string
  if (params.parentAgent !== undefined) options.parentAgent = params.parentAgent as string
  if (params.notifyOnExit !== undefined) options.notifyOnExit = params.notifyOnExit as boolean
  if (params.timeoutSeconds !== undefined) options.timeoutSeconds = params.timeoutSeconds as number
  if (params.cols !== undefined) options.cols = params.cols as number
  if (params.rows !== undefined) options.rows = params.rows as number
  if (params.raw !== undefined) options.raw = params.raw as boolean
  return options
}
