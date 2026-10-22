/**
 * The gate of a route.
 *
 * A route that has a session asks the host: it knows the rules, and it can prompt
 * the user. A route without one - a browser talking to the web interface, a
 * foreign harness on the other side of an MCP socket - enforces a policy instead.
 *
 * The seam is the same for both, so the caller does not have to know which route it
 * is on, and the seam is where a route's own policy drops in.
 */

import type { PermissionAuthorizer, PermissionSubject } from './types.ts'

export class RoutePermissionAuthorizer implements PermissionAuthorizer {
  constructor(
    private readonly host: PermissionAuthorizer | null,
    private readonly policy: PermissionAuthorizer
  ) {}

  async checkCommand(command: string, args: string[], subject?: PermissionSubject): Promise<void> {
    if (this.host !== null && subject?.sessionID !== undefined) {
      await this.host.checkCommand(command, args, subject)
      return
    }
    await this.policy.checkCommand(command, args, subject)
  }

  async checkWorkdir(workdir: string, subject?: PermissionSubject): Promise<void> {
    if (this.host !== null && subject?.sessionID !== undefined) {
      await this.host.checkWorkdir(workdir, subject)
      return
    }
    await this.policy.checkWorkdir(workdir, subject)
  }
}
