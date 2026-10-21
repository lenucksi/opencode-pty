/**
 * Daemon entry point for opencode-pty.
 *
 * Runs as a separate process that owns all PTY sessions. opencode's plugin
 * connects to it over a Unix socket and sends commands; the daemon pushes
 * output and status updates back.
 *
 * Usage: bun run src/daemon/index.ts [--socket PATH] [--state-dir DIR]
 *
 * The daemon lingers after the last client disconnects (idle timeout, default
 * 1 hour) and then shuts down, flushing all buffers to disk first.
 */

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { manager } from '../plugin/pty/manager.ts'
import {
  rawOutputCallbacks,
  sessionRemovedCallbacks,
  sessionUpdateCallbacks,
} from '../plugin/pty/manager-notifications.ts'
import { logPtyEvent } from '../plugin/pty/plugin-log.ts'
import { SessionStore, type RetentionPolicy } from '../plugin/pty/session-store.ts'
import { sessionsRoot } from '../plugin/pty/state-paths.ts'
import type { PTYSessionInfo, SpawnOptions } from '../plugin/pty/types.ts'
import {
  type DaemonRequest,
  type DaemonResponse,
  encodeMessage,
  isRequest,
  parseMessage,
} from './protocol.ts'
import { SocketWriter } from './socket-writer.ts'

const IDLE_TIMEOUT_MS = 60 * 60 * 1000 // 1 hour
const HEARTBEAT_INTERVAL_MS = 30 * 1000 // 30 seconds

interface Client {
  socket: Bun.Socket<undefined>
  /** Queued writer: a response can exceed one socket buffer. See socket-writer.ts. */
  writer: SocketWriter
  id: string
  lastSeen: number
}

const clients = new Map<string, Client>()
let idleTimer: ReturnType<typeof setTimeout> | null = null
let lastActivity = Date.now()

function resetIdleTimer() {
  lastActivity = Date.now()
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    const elapsed = Date.now() - lastActivity
    if (elapsed >= IDLE_TIMEOUT_MS) {
      logPtyEvent('info', 'idle timeout reached, shutting down')
      shutdown()
    }
  }, IDLE_TIMEOUT_MS)
}

function shutdown() {
  logPtyEvent('info', 'daemon shutting down')
  // Flush buffers to disk
  try {
    manager.getSessionStore().close()
  } catch {
    // The store flushes what it can; a failure here must not keep the process up.
  }
  try {
    if (existsSync(socketPath)) unlinkSync(socketPath)
  } catch {
    // Already removed, or not ours to remove.
  }
  const pidFile = join(socketDir, 'ptyd.pid')
  try {
    if (existsSync(pidFile)) unlinkSync(pidFile)
  } catch {
    // Same as the socket above.
  }
  process.exit(0)
}

const { values } = parseArgs({
  options: {
    socket: {
      type: 'string',
      default: join(process.env.XDG_RUNTIME_DIR ?? '/tmp', 'opencode-pty', 'ptyd.sock'),
    },
    'state-dir': { type: 'string', default: sessionsRoot() },
  },
  strict: false,
})

const socketPath = values.socket as string
const stateDir = values['state-dir'] as string

// Ensure socket directory exists
const socketDir = socketPath.substring(0, socketPath.lastIndexOf('/'))
mkdirSync(socketDir, { recursive: true, mode: 0o700 })

// A stale socket is removed; a live one is not stolen. Two daemons starting at
// once is not hypothetical - a host and an explicit restart can race - and the
// loser would otherwise unlink the winner's socket and keep listening on an
// inode nobody can reach.
if (existsSync(socketPath)) {
  let live = false
  try {
    const probe = await Bun.connect({
      unix: socketPath,
      socket: { data() {}, close() {}, error() {} },
    })
    probe.end()
    live = true
  } catch {
    // Nothing listening: stale, safe to remove.
  }
  if (live) {
    logPtyEvent('info', `another daemon is already listening on ${socketPath}; exiting`)
    process.exit(0)
  }
  try {
    unlinkSync(socketPath)
  } catch {
    // Another process removed it between the probe and here.
  }
}

const store = new SessionStore({ root: stateDir })
manager.setSessionStore(store)

// Daemon notifier: pushes exit notifications to connected clients
manager.setNotifier({
  sendExitNotification: async (session, exitCode) => {
    const payload =
      JSON.stringify({ method: 'exit_notification', params: { session, exitCode } }) + '\n'
    for (const client of clients.values()) client.writer.enqueue(payload)
  },
  sendNotice: async () => {},
})

// Register notification callbacks that push to connected clients
rawOutputCallbacks.push((sessionId: string, rawData: string, offset: number) => {
  const msg = JSON.stringify({ method: 'raw_data', params: { sessionId, rawData, offset } }) + '\n'
  for (const client of clients.values()) {
    client.writer.enqueue(msg)
  }
})

sessionUpdateCallbacks.push((session: PTYSessionInfo) => {
  const msg = JSON.stringify({ method: 'session_update', params: { session } }) + '\n'
  for (const client of clients.values()) {
    client.writer.enqueue(msg)
  }
})

sessionRemovedCallbacks.push((sessionId: string) => {
  const msg = JSON.stringify({ method: 'session_removed', params: { sessionId } }) + '\n'
  for (const client of clients.values()) {
    client.writer.enqueue(msg)
  }
})

const restored = manager.loadPersistedSessions()
if (restored.length > 0) {
  logPtyEvent('info', `restored ${restored.length} archived session(s)`, {
    ids: restored.map((session) => session.id),
  })
}

// Apply retention
const prunedRetention = store.updateRetention({})
if (prunedRetention.length > 0) {
  logPtyEvent('info', `retention removed ${prunedRetention.length} archived session(s)`, {
    ids: prunedRetention,
  })
}

const server = Bun.listen({
  unix: socketPath,
  socket: {
    open(_socket) {
      const clientId = `client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      clients.set(clientId, {
        socket: _socket,
        writer: new SocketWriter(_socket),
        id: clientId,
        lastSeen: Date.now(),
      })
      logPtyEvent('info', `client connected: ${clientId}`)
      resetIdleTimer()
    },
    data(_socket, data) {
      const text = new TextDecoder().decode(data)
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue
        const msg = parseMessage(line)
        if (!msg) continue
        if (isRequest(msg)) {
          handleRequest(_socket, msg as DaemonRequest)
        }
      }
      resetIdleTimer()
    },
    drain(_socket) {
      for (const client of clients.values()) {
        if (client.socket === _socket) {
          client.writer.flush()
          return
        }
      }
    },
    close(_socket) {
      for (const [id, client] of clients) {
        if (client.socket === _socket) {
          client.writer.close()
          clients.delete(id)
          logPtyEvent('info', `client disconnected: ${id}`)
          break
        }
      }
      resetIdleTimer()
    },
    error(_socket, err) {
      logPtyEvent('error', 'socket error', err)
    },
  },
})

void server
logPtyEvent('info', `daemon listening on ${socketPath}`)

/** Params as they arrive on the wire; each handler narrows what it needs. */
type WireParams = Record<string, unknown>
type RequestHandler = (params: WireParams, socket: Bun.Socket<undefined>) => unknown

/**
 * One handler per method, so `handleRequest` is a dispatcher rather than a wall.
 *
 * The table is the protocol: a method missing here answers `unknown method`, which
 * is the one place a client can tell that the daemon is older than the plugin.
 */
const handlers: Record<string, RequestHandler> = {
  ping: () => ({ pong: true, generation: store.getGeneration() }),
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

function handleRequest(socket: Bun.Socket<undefined>, req: DaemonRequest) {
  const handler = handlers[req.method]
  let result: unknown
  let error: string | undefined
  try {
    if (handler === undefined) error = `unknown method: ${req.method}`
    else result = handler(req.params ?? {}, socket)
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught)
  }

  const response: DaemonResponse = { id: req.id }
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

// Heartbeat check: remove stale clients, shutdown if all gone for 1h
setInterval(() => {
  const now = Date.now()
  for (const [id, client] of clients) {
    if (now - client.lastSeen > IDLE_TIMEOUT_MS) {
      logPtyEvent('info', `client ${id} timed out (no heartbeat for ${IDLE_TIMEOUT_MS}ms)`)
      try {
        client.socket.end()
      } catch {
        // The socket is already gone; removing the bookkeeping is the point.
      }
      clients.delete(id)
    }
  }
  if (clients.size === 0 && now - lastActivity > IDLE_TIMEOUT_MS) {
    logPtyEvent('info', 'no clients for 1h, shutting down')
    shutdown()
  }
}, HEARTBEAT_INTERVAL_MS)

// Signal handling
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

const pidFile = join(socketDir, 'ptyd.pid')
writeFileSync(pidFile, `${process.pid}\n`, { mode: 0o600 })

logPtyEvent('info', `daemon started (pid ${process.pid}, socket ${socketPath})`)

// Keep the process alive
resetIdleTimer()
