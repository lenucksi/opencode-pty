import { spawn, type IPty } from 'bun-pty'
import { RingBuffer } from './buffer.ts'
import type { PTYSession, PTYSessionInfo, SpawnOptions } from './types.ts'
import {
  DEFAULT_TERMINAL_COLS,
  DEFAULT_TERMINAL_ROWS,
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
function clampDimension(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback
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
      if (!currentSession || currentSession.status !== 'running') {
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
    }
  }

  private spawnProcess(session: PTYSession): void {
    const env = { ...process.env, ...session.env } as Record<string, string>
    const ptyProcess: IPty = spawn(session.command, session.args, {
      name: 'xterm-256color',
      cols: DEFAULT_TERMINAL_COLS,
      rows: DEFAULT_TERMINAL_ROWS,
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

  resize(id: string, cols: number, rows: number): boolean {
    const session = this.sessions.get(id)
    if (!session) {
      return false
    }

    const boundedCols = clampDimension(
      cols,
      MIN_TERMINAL_COLS,
      MAX_TERMINAL_COLS,
      DEFAULT_TERMINAL_COLS
    )
    const boundedRows = clampDimension(
      rows,
      MIN_TERMINAL_ROWS,
      MAX_TERMINAL_ROWS,
      DEFAULT_TERMINAL_ROWS
    )

    try {
      session.process?.resize(boundedCols, boundedRows)
    } catch {
      // Ignore resize errors (e.g. process already exited)
    }

    return true
  }

  private clearAllSessionsInternal(): void {
    for (const id of [...this.sessions.keys()]) {
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
      notifyOnExit: session.notifyOnExit,
      timeoutSeconds: session.timeoutSeconds,
      timedOut: session.timedOut,
      exitCode: session.exitCode,
      exitSignal: session.exitSignal,
      pid: session.pid,
      createdAt: session.createdAt.toISOString(),
      lineCount: session.buffer.length,
    }
  }
}
