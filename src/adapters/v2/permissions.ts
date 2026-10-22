/**
 * The V2 permission authorizer: the host's own permission system.
 *
 * The host owns the rules - the agent's, the session's and the saved ones - and it
 * owns the question. `assert` evaluates them and, when approval is required,
 * PROMPTS the user and waits for the reply. A plugin cannot ask that question any
 * other way: the V1 route had to turn "ask" into "deny", because a plugin could
 * not ask a human anything.
 *
 * The session is the unit the host knows rules by, so a caller that has one passes
 * it. A caller that has none - the web interface, which a browser talks to - is
 * not asked: the host cannot answer for a session it does not know, and a rule
 * nobody can be asked about is not a rule.
 */

import type { PermissionAuthorizer, PermissionSubject } from '../types.ts'
import type { HostPermissionDomain } from '../../v2/types.ts'

/**
 * The command as the host's rules are written against them.
 *
 * The host's own shell tool hands the permission system the parsed command's
 * resource, which is the command line. The rules in a config read like
 * `"git *": "allow"`, so the resource has to be the same shape the pattern was
 * written for.
 */
function commandLine(command: string, args: string[]): string {
  return [command, ...args].join(' ')
}

export class V2PermissionAuthorizer implements PermissionAuthorizer {
  constructor(private readonly permission: HostPermissionDomain) {}

  async checkCommand(command: string, args: string[], subject?: PermissionSubject): Promise<void> {
    if (!subject?.sessionID) return
    await this.permission.assert({
      sessionID: subject.sessionID,
      ...(subject.agent === undefined ? {} : { agent: subject.agent }),
      action: 'bash',
      resources: [commandLine(command, args)],
    })
  }

  async checkWorkdir(workdir: string, subject?: PermissionSubject): Promise<void> {
    if (!subject?.sessionID) return
    await this.permission.assert({
      sessionID: subject.sessionID,
      ...(subject.agent === undefined ? {} : { agent: subject.agent }),
      action: 'external_directory',
      resources: [workdir],
    })
  }
}
