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
import { SessionStore } from '../plugin/pty/session-store.ts'
import { sessionsRoot } from '../plugin/pty/state-paths.ts'
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
  socket: any
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
  } catch {}
  // Clean up socket
  try {
    if (existsSync(socketPath)) unlinkSync(socketPath)
  } catch {}
  const pidFile = join(socketDir, 'ptyd.pid')
  try {
    if (existsSync(pidFile)) unlinkSync(pidFile)
  } catch {}
  process.exit(0)
}

// Parse args
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
  } catch {}
}

// Initialize the session store with the right root
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

sessionUpdateCallbacks.push((session: any) => {
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

// Load persisted sessions
const restored = manager.loadPersistedSessions()
if (restored.length > 0) {
  logPtyEvent('info', `restored ${restored.length} archived session(s)`, {
    ids: restored.map((s: any) => s.id),
  })
}

// Apply retention
const prunedRetention = store.updateRetention({})
if (prunedRetention.length > 0) {
  logPtyEvent('info', `retention removed ${prunedRetention.length} archived session(s)`, {
    ids: prunedRetention,
  })
}

// Start the socket server
const server = Bun.listen({
  unix: socketPath,
  socket: {
    open(_socket) {
      const clientId = `client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      clients.set(clientId, {
        socket: _socket as any,
        writer: new SocketWriter(_socket as any),
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

// Handle incoming requests
function handleRequest(socket: any, req: DaemonRequest) {
  let result: unknown
  let error: string | undefined

  try {
    switch (req.method) {
      case 'ping':
        result = { pong: true, generation: store.getGeneration() }
        break
      case 'list':
        result = manager.list()
        break
      case 'spawn':
        result = manager.spawn(req.params as any)
        break
      case 'write':
        result = { success: manager.write(req.params?.id as string, req.params?.data as string) }
        break
      case 'read':
        result = manager.read(
          req.params?.id as string,
          req.params?.offset as number,
          req.params?.limit as number,
          req.params?.budget as number
        )
        break
      case 'kill':
        result = { success: manager.kill(req.params?.id as string, req.params?.cleanup as boolean) }
        break
      case 'resize':
        result = {
          success: manager.resize(
            req.params?.id as string,
            req.params?.cols as number,
            req.params?.rows as number
          ),
        }
        break
      case 'heartbeat':
        for (const client of clients.values()) {
          if (client.socket === socket) {
            client.lastSeen = Date.now()
            break
          }
        }
        result = { ok: true }
        break
      case 'search': {
        const regex = new RegExp(req.params?.pattern as string, req.params?.ignoreCase ? 'i' : '')
        result = manager.search(
          req.params?.id as string,
          regex,
          (req.params?.offset as number) ?? 0,
          req.params?.limit as number,
          req.params?.budget as number
        )
        break
      }
      case 'get':
        result = manager.get(req.params?.id as string)
        break
      case 'get_session':
        result = manager.getSession(req.params?.id as string)
        break
      case 'get_session_log':
        result = manager.getSessionLog(req.params?.id as string, {
          tail: req.params?.tail as number,
        })
        break
      case 'describe_missing_session':
        result = manager.describeMissingSession(req.params?.id as string)
        break
      case 'describe_server':
        result = manager.describeServer()
        break
      case 'get_raw_buffer':
        result = manager.getRawBuffer(req.params?.id as string, req.params?.since as number)
        break
      case 'read_since':
        result = manager.readSince(
          req.params?.id as string,
          req.params?.since as number,
          req.params?.budget as number
        )
        break
      case 'cleanup_by_session':
        manager.cleanupBySession(req.params?.parentSessionId as string)
        result = { ok: true }
        break
      case 'load_persisted_sessions':
        result = manager.loadPersistedSessions()
        break
      case 'bulk_remove':
        result = manager.bulkRemove(req.params?.ids as string[])
        break
      case 'restore_sessions':
        result = manager.restoreSessions(req.params?.ids as string[])
        break
      case 'clear_all_sessions':
        manager.clearAllSessions()
        result = { ok: true }
        break
      case 'note_client_size':
        manager.noteClientSize(req.params?.cols as number, req.params?.rows as number)
        result = { ok: true }
        break
      case 'get_retention':
        result = { retention: store.getRetention() }
        break
      case 'update_retention':
        result = { pruned: store.updateRetention(req.params?.policy as any) }
        break
      case 'get_generation':
        result = { generation: store.getGeneration() }
        break
      case 'get_state_dir':
        result = { stateDir: store.getRoot() }
        break
      case 'list_persisted':
        result = store.list()
        break
      case 'read_persisted':
        result = store.read(
          req.params?.id as string,
          req.params?.offset as number,
          req.params?.limit as number
        )
        break
      default:
        error = `unknown method: ${req.method}`
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  const response: DaemonResponse = { id: req.id }
  if (error) response.error = error
  else response.result = result
  const target = [...clients.values()].find((client) => client.socket === socket)
  if (target !== undefined) target.writer.enqueue(encodeMessage(response))
  else {
    try {
      socket.write(encodeMessage(response))
    } catch {}
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
      } catch {}
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

// Write PID file
const pidFile = join(socketDir, 'ptyd.pid')
writeFileSync(pidFile, `${process.pid}\n`, { mode: 0o600 })

logPtyEvent('info', `daemon started (pid ${process.pid}, socket ${socketPath})`)

// Keep the process alive
resetIdleTimer()
