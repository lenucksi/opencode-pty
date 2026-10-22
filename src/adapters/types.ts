import type { PTYSession } from '../plugin/pty/types.ts'

/** Anything that needs to wake a session with text (exit, restart, ...). */
export interface SessionNoticeTarget {
  /** PTY session id; also the base of the deterministic message id. */
  id: string
  parentSessionId: string
  parentAgent?: string
}

/**
 * Host-agnostic interface for waking a session.
 * Allows decoupling PTY lifecycle from any specific OpenCode client SDK.
 */
export interface SessionNotifier {
  sendExitNotification(session: PTYSession, exitCode: number): Promise<void> | void
  /**
   * Wake a session with arbitrary text. Optional: a host that can only report
   * exits keeps working, and callers log when it is unavailable.
   */
  sendNotice?(target: SessionNoticeTarget, text: string, kind: string): Promise<void> | void
}

/**
 * Who asks for a permission.
 *
 * The host knows its rules per session, so a caller that has one says which
 * session the question is about. A caller that has none (the web interface, which
 * a browser talks to) leaves it out, and the authorizer decides what to do
 * without one.
 */
export interface PermissionSubject {
  /** The session the decision belongs to. */
  readonly sessionID?: string
  /** The agent asking. The host resolves the session's own agent when it is absent. */
  readonly agent?: string
}

/**
 * Host-agnostic authorizer for validating command and workdir execution permissions.
 *
 * Each route asks its own context: inside OpenCode the host evaluates the rules
 * and prompts the user, and outside it the caller enforces a policy of its own.
 * The interface is what both answer to.
 */
export interface PermissionAuthorizer {
  checkCommand(command: string, args: string[], subject?: PermissionSubject): Promise<void>
  checkWorkdir(workdir: string, subject?: PermissionSubject): Promise<void>
}

/**
 * Common host adapter contract bridging a host environment (e.g. OpenCode V1, V2, Standalone)
 * with the core PTY manager and execution environment.
 */
export interface HostAdapter {
  readonly id: string
  readonly notifier?: SessionNotifier
  readonly permissions?: PermissionAuthorizer
  onSessionDeleted?(sessionId: string): void
}
