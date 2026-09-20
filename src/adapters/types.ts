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
 * Host-agnostic authorizer for validating command and workdir execution permissions.
 */
export interface PermissionAuthorizer {
  checkCommand(command: string, args: string[]): Promise<void>
  checkWorkdir(workdir: string): Promise<void>
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
