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

import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
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
import type { PTYSessionInfo } from '../plugin/pty/types.ts'
import { type DaemonRequest, isRequest, parseMessage } from './protocol.ts'
import { createRequestHandler } from './requests.ts'
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

/**
 * The pid of the daemon that owns the socket path, if it is not this one.
 *
 * The pid file is the machine's answer to "which daemon is the real one". A daemon
 * whose path was taken over finds its own pid missing from that file - and the file
 * is the only thing that can say so, because a daemon that lost the path cannot see
 * the path any more.
 */
function ownerPid(): number | null {
  try {
    const parsed = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
  } catch {
    return null
  }
}

function shutdown() {
  logPtyEvent('info', 'daemon shutting down')
  // Flush buffers to disk
  try {
    manager.getSessionStore().close()
  } catch {
    // The store flushes what it can; a failure here must not keep the process up.
  }
  // A daemon that was superseded must not remove the successor's socket or pid
  // file: it is listening on an inode nobody can reach, and the path belongs to
  // somebody else now.
  if (pathIsMine()) {
    try {
      if (existsSync(socketPath)) unlinkSync(socketPath)
    } catch {
      // Already removed, or not ours to remove.
    }
  }
  try {
    if (ownerPid() === process.pid && existsSync(pidFile)) unlinkSync(pidFile)
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

/**
 * Who owns the socket path, in a file.
 *
 * The pid file is written when the daemon binds and removed when it stops - but
 * only by the daemon that owns the path, because a daemon that was superseded must
 * not delete its successor's file.
 */
const pidFile = join(socketDir, 'ptyd.pid')

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

/**
 * The dispatcher, with the method table behind it.
 *
 * The table lives in `requests.ts`: it is a long list of short answers, and this
 * file is about being a daemon.
 */
const handleRequest = createRequestHandler(store, clients)

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

/**
 * The inode of the socket this daemon serves.
 *
 * A Unix socket is a file, and the file's identity survives every connection to
 * it. Comparing inodes is therefore the precise answer to "is that path still
 * mine": a daemon whose path was taken over finds a different inode there, and a
 * daemon that still serves the path finds its own. The pid file cannot say this:
 * it is a note, and a note can be wrong.
 */
let servedIno: number | null = null

/**
 * Is the socket path still the one this daemon serves?
 *
 * False means nobody can reach this daemon any more: either the path was taken
 * over or it is gone. Either way it holds sessions that nobody can use, so it has
 * to step aside.
 */
function pathIsMine(): boolean {
  if (servedIno === null) return false
  try {
    return statSync(socketPath).ino === servedIno
  } catch {
    return false
  }
}

const server = listen()

/**
 * Bind the socket, or step aside.
 *
 * The path can be taken between the probe above and this call - another daemon
 * binding it in that window is not hypothetical, because every opencode instance
 * on the machine starts one. A crash here would take the machine's log with it, and
 * the daemon that owns the path is the one that should stay.
 */
function listen(): ReturnType<typeof Bun.listen<undefined>> {
  try {
    return Bun.listen({
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
  } catch (error) {
    logPtyEvent('info', `another daemon owns ${socketPath}; exiting`, { error: String(error) })
    process.exit(0)
  }
}

void server
// The inode of the socket we serve. From here on it is the answer to "is the path
// at that name still mine" - the pid file is a note about it, and a note can be
// wrong.
try {
  servedIno = statSync(socketPath).ino
} catch {
  servedIno = null
}
logPtyEvent('info', `daemon listening on ${socketPath}`)

/** Params as they arrive on the wire; each handler narrows what it needs. */
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
  // A daemon that was superseded retires. The path is taken, this daemon is
  // listening on an inode nobody can reach, and the machine would otherwise keep
  // both: the pid file names the daemon that owns the path now.
  if (clients.size === 0 && now - lastActivity > IDLE_TIMEOUT_MS) {
    logPtyEvent('info', 'no clients for 1h, shutting down')
    shutdown()
  }
}, HEARTBEAT_INTERVAL_MS)
/**
 * The retirement check, on its own clock.
 *
 * A daemon that lost the socket path to a successor is a daemon nobody can reach,
 * and it holds every session it owns. It has to notice on its own, and it cannot
 * wait an hour to do it - so this runs on seconds, not on the heartbeat.
 *
 * The path decides, not the pid file: the inode under the name is the ground
 * truth about who serves it. The pid file is kept in step with that, because a
 * restart reads it - and a restart that reads a pid that is not there kills
 * nothing and reports that it did.
 */
setInterval(() => {
  if (!pathIsMine()) {
    logPtyEvent('info', 'the socket path is no longer ours; retiring')
    shutdown()
    return
  }
  if (ownerPid() !== process.pid) {
    try {
      writeFileSync(pidFile, `${process.pid}\n`, { mode: 0o600 })
    } catch {
      // The file is not ours to write; the next tick tries again.
    }
  }
}, 2000)

// Signal handling
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

writeFileSync(pidFile, `${process.pid}\n`, { mode: 0o600 })

logPtyEvent('info', `daemon started (pid ${process.pid}, socket ${socketPath})`)

// Keep the process alive
resetIdleTimer()
