import { join } from 'node:path'

export interface StateEnvironment {
  XDG_STATE_HOME?: string
  HOME?: string
  [key: string]: string | undefined
}

/**
 * Root for everything the PTY layer keeps across runs.
 *
 * Kept next to the plugin log (`opencode-pty.log`) so a single directory holds
 * the debug trail and the archived sessions.
 */
export function stateRoot(env: StateEnvironment = process.env): string {
  const stateHome = env.XDG_STATE_HOME ?? (env.HOME ? join(env.HOME, '.local', 'state') : '/tmp')
  return join(stateHome, 'opencode', 'opencode-pty')
}

/**
 * One directory per archived session: `<root>/sessions/<id>`.
 *
 * `OPENCODE_PTY_STATE_DIR` overrides the whole location, which keeps test
 * servers (and their "clear sessions" calls) away from a real archive.
 */
export function sessionsRoot(env: StateEnvironment = process.env): string {
  return env.OPENCODE_PTY_STATE_DIR ?? join(stateRoot(env), 'sessions')
}

export function sessionDir(id: string, env: StateEnvironment = process.env): string {
  return join(sessionsRoot(env), id)
}
