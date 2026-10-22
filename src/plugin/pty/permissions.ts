import type { PermissionAuthorizer, PermissionSubject } from '../../adapters/types.ts'

export type { PermissionAuthorizer, PermissionSubject }

let _authorizer: PermissionAuthorizer | null = null

/**
 * Sets the active permission authorizer for PTY command and directory checks.
 */
export function setPermissionAuthorizer(authorizer: PermissionAuthorizer | null): void {
  _authorizer = authorizer
}

/**
 * Returns the currently active permission authorizer, if any.
 */
export function getPermissionAuthorizer(): PermissionAuthorizer | null {
  return _authorizer
}

/**
 * Checks command execution permission against the active authorizer.
 *
 * The subject is who is asking: the host knows its rules per session, so a caller
 * that has a session says which one. No authorizer means no gate - a host that
 * has none is a host this plugin cannot ask.
 */
export async function checkCommandPermission(
  command: string,
  args: string[],
  subject?: PermissionSubject
): Promise<void> {
  if (_authorizer) {
    await _authorizer.checkCommand(command, args, subject)
  }
}

/**
 * Checks working directory access permission against the active authorizer.
 *
 * Defaults to allowing if no authorizer is set.
 */
export async function checkWorkdirPermission(
  workdir: string,
  subject?: PermissionSubject
): Promise<void> {
  if (_authorizer) {
    await _authorizer.checkWorkdir(workdir, subject)
  }
}
