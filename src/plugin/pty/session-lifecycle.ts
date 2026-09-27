import { spawn, type IPty } from 'bun-pty'
import { RingBuffer } from './buffer.ts'
import type { PTYSession, PTYSessionInfo, SpawnOptions } from './types.ts'
import {
  FALLBACK_TERMINAL_COLS,
  FALLBACK_TERMINAL_ROWS,
  MAX_TERMINAL_COLS,
  MAX_TERMINAL_ROWS,
  MIN_TERMINAL_COLS,
  MIN_TERMINAL_ROWS,
} from '../constants.ts'

const SESSION_ID_BYTE_LENGTH = 4

/**
 * Clamp a terminal dimension to the PTY-supported range. Non-finite values
 * (NaN/Infinity) or values outside the range fall back to sane bounds.
 */
function clampDimension(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number
): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback
  }
  return Math.min(max, Math.max(min, Math.floor(value)))
}

/**
 * Clamp an explicitly requested size, falling back to the session's current one.
 *
 * Used by `pty_resize`, where a caller may legitimately send only one dimension
 * and mean "keep the other". Falling back to the session's own size rather than
 * to a global default is what makes a partial resize not silently reset the
 * axis that was left out.
 */
function clampAgainst(
  value: number | undefined,
  min: number,
  max: number,
  current: number
): number {
  if (value === undefined || !Number.isFinite(value)) {
    return current
  }
  return Math.min(max, Math.max(min, Math.floor(value)))
}

function generateId(): string {
  const hex = Array.from(crypto.getRandomValues(new Uint8Array(SESSION_ID_BYTE_LENGTH)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return `pty_${hex}`
}

export class SessionLifecycleManager {
  private sessions: Map<string, PTYSession> = new Map()
  private sessionTimeouts: Map<string, ReturnType<typeof setTimeout>> = new Map()

  private normalizeTimeoutSeconds(timeoutSeconds: number | undefined): number | undefined {
    if (timeoutSeconds === undefined) {
      return undefined
    }

    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0) {
      throw new Error('timeoutSeconds must be a positive integer in seconds')
    }

    return timeoutSeconds
  }

  private clearSessionTimeout(id: string): void {
    const timeoutHandle = this.sessionTimeouts.get(id)
    if (!timeoutHandle) {
      return
    }

    clearTimeout(timeoutHandle)
    this.sessionTimeouts.delete(id)
  }

  private scheduleSessionTimeout(session: PTYSession): void {
    if (session.timeoutSeconds === undefined) {
      return
    }

    const timeoutMs = session.timeoutSeconds * 1000

    const timeoutHandle = setTimeout(() => {
      this.sessionTimeouts.delete(session.id)

      const currentSession = this.sessions.get(session.id)
      if (currentSession?.status !== 'running') {
        return
      }

      // Persist the timeout reason before reusing the regular kill flow.
      currentSession.timedOut = true
      currentSession.status = 'killing'

      try {
        currentSession.process?.kill()
      } catch {
        // Ignore kill errors
      }
    }, timeoutMs)

    this.sessionTimeouts.set(session.id, timeoutHandle)
  }

  private createSessionObject(opts: SpawnOptions): PTYSession {
    const id = generateId()
    const args = opts.args ?? []
    const workdir = opts.workdir ?? process.cwd()
    const timeoutSeconds = this.normalizeTimeoutSeconds(opts.timeoutSeconds)
    const title =
      opts.title ?? (`${opts.command} ${args.join(' ')}`.trim() || `Terminal ${id.slice(-4)}`)

    const buffer = new RingBuffer()
    // Resolved once, here, so the spawn, the info and any later resize all agree
    // on a single number. Re-deriving it at each use is how a session ends up
    // reporting 80x24 while actually running at 120x40.
    const cols = clampDimension(
      opts.cols,
      MIN_TERMINAL_COLS,
      MAX_TERMINAL_COLS,
      FALLBACK_TERMINAL_COLS
    )
    const rows = clampDimension(
      opts.rows,
      MIN_TERMINAL_ROWS,
      MAX_TERMINAL_ROWS,
      FALLBACK_TERMINAL_ROWS
    )
    return {
      id,
      title,
      description: opts.description,
      command: opts.command,
      args,
      workdir,
      env: opts.env,
      status: 'running',
      pid: 0, // will be set after spawn
      createdAt: new Date(),
      parentSessionId: opts.parentSessionId,
      parentAgent: opts.parentAgent,
      notifyOnExit: opts.notifyOnExit ?? false,
      timeoutSeconds,
      timedOut: false,
      buffer,
      process: null, // will be set
      cols,
      rows,
    }
  }

  private spawnProcess(session: PTYSession): void {
    const env = { ...process.env, ...session.env } as Record<string, string>
    const ptyProcess: IPty = spawn(session.command, session.args, {
      name: 'xterm-256color',
      cols: session.cols,
      rows: session.rows,
      cwd: session.workdir,
      env,
    })
    session.process = ptyProcess
    session.pid = ptyProcess.pid
  }

  private setupEventHandlers(
    session: PTYSession,
    onData: (session: PTYSession, data: string, offset: number) => void,
    onExit: (session: PTYSession, exitCode: number | null) => void
  ): void {
    session.process?.onData((data: string) => {
      const offset = session.buffer.append(data)
      onData(session, data, offset)
    })

    session.process?.onExit(({ exitCode, signal }) => {
      this.clearSessionTimeout(session.id)

      if (session.status === 'killing') {
        session.status = 'killed'
      } else {
        session.status = 'exited'
      }
      session.exitCode = exitCode
      session.exitSignal = signal
      session.endedAt = new Date()
      onExit(session, exitCode)
    })
  }

  spawn(
    opts: SpawnOptions,
    onData: (session: PTYSession, data: string, offset: number) => void,
    onExit: (session: PTYSession, exitCode: number | null) => void
  ): PTYSessionInfo {
    const session = this.createSessionObject(opts)
    this.spawnProcess(session)
    this.setupEventHandlers(session, onData, onExit)
    this.sessions.set(session.id, session)
    this.scheduleSessionTimeout(session)
    return this.toInfo(session)
  }

  kill(id: string, cleanup: boolean = false): boolean {
    const session = this.sessions.get(id)
    if (!session) {
      return false
    }

    this.clearSessionTimeout(id)

    if (session.status === 'running') {
      session.status = 'killing'
      try {
        session.process?.kill()
      } catch {
        // Ignore kill errors
      }
    }

    if (cleanup) {
      session.buffer.clear()
      this.sessions.delete(id)
    }

    return true
  }

  /**
   * Resize a running session, recording the size it ended up at.
   *
   * The recording is the point. The size used to be handed to the PTY and then
   * forgotten, so nothing could report it: the agent could not tell a cramped
   * program from a broken one, and the web UI could not tell a resize that had
   * been clamped from one that had been honoured.
   *
   * An omitted or non-finite dimension keeps the session's current value rather
   * than snapping to a global default, so a partial resize cannot reset the axis
   * the caller left out.
   */
  resize(id: string, cols?: number, rows?: number): boolean {
    const session = this.sessions.get(id)
    if (!session) {
      return false
    }

    const boundedCols = clampAgainst(cols, MIN_TERMINAL_COLS, MAX_TERMINAL_COLS, session.cols)
    const boundedRows = clampAgainst(rows, MIN_TERMINAL_ROWS, MAX_TERMINAL_ROWS, session.rows)

    try {
      session.process?.resize(boundedCols, boundedRows)
    } catch {
      // Ignore resize errors (e.g. process already exited)
    }

    // Recorded even when the process is already gone: the size is then the size
    // this session ran at, which is exactly what a later reader wants to know.
    session.cols = boundedCols
    session.rows = boundedRows

    return true
  }

  private clearAllSessionsInternal(): void {
    for (const id of this.sessions.keys()) {
      this.kill(id, true)
    }
  }

  clearAllSessions(): void {
    this.clearAllSessionsInternal()
  }

  cleanupBySession(parentSessionId: string): void {
    for (const [id, session] of this.sessions) {
      if (session.parentSessionId === parentSessionId) {
        this.kill(id, true)
      }
    }
  }

  getSession(id: string): PTYSession | null {
    return this.sessions.get(id) || null
  }

  listSessions(): PTYSession[] {
    return Array.from(this.sessions.values())
  }

  toInfo(session: PTYSession): PTYSessionInfo {
    return {
      id: session.id,
      title: session.title,
      description: session.description,
      command: session.command,
      args: session.args,
      workdir: session.workdir,
      status: session.status,
      ...(session.endedAt === undefined ? {} : { endedAt: session.endedAt.toISOString() }),
      notifyOnExit: session.notifyOnExit,
      timeoutSeconds: session.timeoutSeconds,
      timedOut: session.timedOut,
      exitCode: session.exitCode,
      exitSignal: session.exitSignal,
      pid: session.pid,
      createdAt: session.createdAt.toISOString(),
      parentSessionId: session.parentSessionId,
      parentAgent: session.parentAgent,
      lineCount: session.buffer.length,
      charCount: session.buffer.charLength,
      cols: session.cols,
      rows: session.rows,
    }
  }
}
