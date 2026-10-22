/**
 * A policy of the route's own.
 *
 * Some routes cannot ask the host: an MCP server is a foreign process, and a
 * browser talking to the web interface has no conversation for the host's rules to
 * belong to. Those routes enforce a policy instead - the same patterns and the same
 * semantics the host uses, read from the same configuration, and a rule that needs
 * a human becomes a refusal because there is no human to ask.
 *
 * The semantics are the host's, deliberately: the most specific matching pattern
 * wins, and a command that matches nothing is not allowed. A user who wrote
 * `"git *": "allow"` in their OpenCode configuration wrote it for this too.
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { match } from './wildcard.ts'

/** What a rule does when it matches. */
export type PolicyEffect = 'allow' | 'ask' | 'deny'

/** One rule: an action, a pattern for the resource, and what happens then. */
export interface PolicyRule {
  /** The action the rule is about: `bash` for a command, `external_directory` for a path. */
  readonly action: string
  /** The pattern the resource is matched against, e.g. `git *`. */
  readonly resource: string
  readonly effect: PolicyEffect
}

/**
 * The rules of a configuration's `permission` block.
 *
 * The same shape the host reads: a single effect for everything, or one per action,
 * and inside an action one effect for everything or one per pattern.
 */
export function policyFromConfig(config: unknown): PolicyRule[] {
  if (typeof config !== 'object' || config === null) return []
  const block = (config as { permission?: unknown }).permission
  if (typeof block === 'string') {
    const effect = asEffect(block)
    return effect === null ? [] : [{ action: '*', resource: '*', effect }]
  }
  if (typeof block !== 'object' || block === null) return []
  const rules: PolicyRule[] = []
  for (const [action, value] of Object.entries(block as Record<string, unknown>)) {
    if (typeof value === 'string') {
      const effect = asEffect(value)
      if (effect !== null) rules.push({ action, resource: '*', effect })
      continue
    }
    if (typeof value !== 'object' || value === null) continue
    for (const [resource, raw] of Object.entries(value as Record<string, unknown>)) {
      const effect = asEffect(raw)
      if (effect !== null) rules.push({ action, resource, effect })
    }
  }
  return rules
}

function asEffect(value: unknown): PolicyEffect | null {
  return value === 'allow' || value === 'ask' || value === 'deny' ? value : null
}

/**
 * What the rules say about one action and one resource.
 *
 * The most specific matching pattern wins - a longer pattern is a more specific
 * one. A resource that matches nothing is the caller's business, and the caller
 * says so: the host asks the user, a route that cannot asks for nothing and
 * decides itself. The fallback is therefore an argument, not a default - a default
 * would hide the decision behind the call.
 */
export function evaluatePolicy(
  rules: readonly PolicyRule[],
  action: string,
  resource: string,
  fallback: PolicyEffect
): PolicyEffect {
  const matching = rules
    .filter((rule) => match(action, rule.action) && match(resource, rule.resource))
    .sort((a, b) => b.resource.length - a.resource.length)
  const best = matching[0]
  // No rule matched: the caller's decision, stated by the caller.
  if (best === undefined) return fallback
  return best.effect
}

/**
 * The rules of the configuration files on this machine.
 *
 * The global OpenCode configuration and the project's own, because those are where
 * a user's rules live. A file that is not there is not a failure - a machine
 * without OpenCode has no rules, and a machine with a broken one is refused rather
 * than opened.
 */
export function readPolicyFromConfigs(paths: readonly string[]): PolicyRule[] {
  const rules: PolicyRule[] = []
  for (const path of paths) {
    const config = readConfig(path)
    if (config === null) continue
    rules.push(...policyFromConfig(config))
  }
  return rules
}

/** The configuration files a policy reads, for a project directory. */
export function policyConfigPaths(projectDirectory?: string): string[] {
  const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
  const paths = [join(configHome, 'opencode', 'opencode.json')]
  if (projectDirectory !== undefined) {
    paths.push(join(projectDirectory, 'opencode.json'))
    paths.push(join(projectDirectory, '.opencode', 'opencode.json'))
  }
  return paths
}

/** The policy file of a route that has no host to ask. */
export function policyFilePath(): string {
  const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
  return join(configHome, 'opencode-pty', 'permissions.json')
}

/**
 * One configuration file, or null when there is none to read.
 *
 * Only plain JSON: the host also reads `opencode.jsonc`, and a file with comments
 * in it is not a file this reader can claim to understand. Refusing to read it is
 * the safe direction - a rule that is not read is a rule that does not allow.
 */
function readConfig(path: string): unknown | null {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    return null
  }
}
