import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type PtyLogLevel = 'info' | 'warn' | 'error'

export type PtyLogger = (level: PtyLogLevel, message: string, details?: unknown) => void

export interface PtyLogEnvironment {
  XDG_STATE_HOME?: string
  HOME?: string
  [key: string]: string | undefined
}

/**
 * Plugin `console` output shares the host's stdout, which is not captured in
 * opencode's own log — so a dropped exit notification used to be completely
 * invisible. Everything the PTY layer wants to be debuggable goes to a file as
 * well.
 */
export function ptyLogPath(env: PtyLogEnvironment): string {
  const stateHome = env.XDG_STATE_HOME ?? (env.HOME ? join(env.HOME, '.local', 'state') : '/tmp')
  return join(stateHome, 'opencode', 'opencode-pty.log')
}

export function formatLogLine(
  level: PtyLogLevel,
  message: string,
  details?: unknown,
  now: Date = new Date()
): string {
  const suffix = details === undefined ? '' : ` ${formatDetails(details)}`
  return `${now.toISOString()} ${level.toUpperCase()} ${message}${suffix}\n`
}

function formatDetails(details: unknown): string {
  if (details instanceof Error) {
    return `${details.name}: ${details.message}`
  }
  if (typeof details === 'string') {
    return details
  }
  try {
    return JSON.stringify(details)
  } catch {
    return String(details)
  }
}

/** Append one line to the PTY log, then mirror it to the console. */
export function logPtyEvent(level: PtyLogLevel, message: string, details?: unknown): void {
  try {
    const path = ptyLogPath(process.env)
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, formatLogLine(level, message, details))
  } catch {
    // Logging must never take the PTY layer down.
  }

  if (level === 'error') {
    console.error(`[opencode-pty] ${message}`, details ?? '')
  } else if (level === 'warn') {
    console.warn(`[opencode-pty] ${message}`, details ?? '')
  }
}
