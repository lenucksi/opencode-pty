/**
 * The authorizer of a route that cannot ask the host.
 *
 * The rules are the host's semantics, the source is the user's configuration, and
 * a rule that needs a human becomes a refusal: there is nobody to ask. That is the
 * same trade the V1 route made, with one difference - the rules are read from the
 * configuration itself instead of from the host's resolved view, so a machine
 * without an OpenCode can enforce the same policy.
 */

import type { PermissionAuthorizer, PermissionSubject } from '../../adapters/types.ts'
import { logPtyEvent } from './plugin-log.ts'
import {
  evaluatePolicy,
  type PolicyEffect,
  type PolicyRule,
  policyConfigPaths,
  policyFilePath,
  readPolicyFromConfigs,
} from './policy.ts'

/** The action a command is checked under. The host's own name for it. */
const BASH_ACTION = 'bash'
/** The action a working directory outside the project is checked under. */
const EXTERNAL_DIRECTORY_ACTION = 'external_directory'

export interface PolicyAuthorizerOptions {
  /** The rules to enforce. Read from the configuration files when absent. */
  readonly rules?: readonly PolicyRule[]
  /** The project directory whose configuration counts as the project's. */
  readonly projectDirectory?: string
  /**
   * What a command that matches no rule gets.
   *
   * The host asks the user; a route that cannot has to decide. The web interface
   * is the user's own surface and keeps what it always did - a command nobody
   * wrote a rule about runs - while a foreign harness gets the other answer,
   * because there the user never said yes to anything.
   */
  readonly defaultEffect?: PolicyEffect
}

export class PolicyAuthorizer implements PermissionAuthorizer {
  private readonly rules: readonly PolicyRule[]
  private readonly defaultEffect: PolicyEffect

  constructor(options: PolicyAuthorizerOptions = {}) {
    this.rules = options.rules ?? readPolicyFromConfigs(policyConfigPaths(options.projectDirectory))
    this.defaultEffect = options.defaultEffect ?? 'allow'
    logPtyEvent('info', `permission policy loaded: ${this.rules.length} rule(s)`, {
      rules: this.rules,
    })
  }

  async checkCommand(command: string, args: string[], _subject?: PermissionSubject): Promise<void> {
    this.decide(BASH_ACTION, [command, ...args].join(' '))
  }

  async checkWorkdir(workdir: string, _subject?: PermissionSubject): Promise<void> {
    this.decide(EXTERNAL_DIRECTORY_ACTION, workdir)
  }

  /**
   * The decision, and what happens with it.
   *
   * `ask` is a refusal here: the rule wants a human, and a route without a host
   * has no way to reach one. Saying so is better than letting the command run.
   */
  private decide(action: string, resource: string): void {
    const effect = evaluatePolicy(this.rules, action, resource, this.defaultEffect)
    if (effect === 'allow') return
    if (effect === 'deny') {
      throw new Error(
        `PTY spawn denied: "${resource}" is denied by the permission policy (${action}).`
      )
    }
    throw new Error(
      `PTY spawn denied: "${resource}" needs approval (${action}), and this route cannot ask. Allow it in the permission policy.`
    )
  }
}

/**
 * The policy file of a route, on top of the configuration files.
 *
 * A route that has no host to ask gets its own file, and the rules in it are the
 * user's own decision about what that route may start.
 */
export function readPolicyFile(path: string = policyFilePath()): PolicyRule[] {
  return readPolicyFromConfigs([path])
}
