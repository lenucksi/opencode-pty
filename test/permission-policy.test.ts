/**
 * The policy of a route that cannot ask the host.
 *
 * The rules are the host's semantics, so a user who wrote `"git *": "allow"` in
 * their OpenCode configuration wrote it for this too. What differs is the default:
 * the host asks the user, a route without a host decides itself.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PolicyAuthorizer } from '../src/plugin/pty/policy-authorizer.ts'
import {
  evaluatePolicy,
  policyFromConfig,
  type PolicyRule,
  readPolicyFromConfigs,
} from '../src/plugin/pty/policy.ts'

const temps: string[] = []

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function configFile(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'opencode-pty-policy-'))
  temps.push(dir)
  const path = join(dir, 'opencode.json')
  writeFileSync(path, JSON.stringify(content))
  return path
}

describe('the permission policy', () => {
  describe('reading the rules', () => {
    it('reads the shapes the host reads', () => {
      expect(policyFromConfig({ permission: 'deny' })).toEqual([
        { action: '*', resource: '*', effect: 'deny' },
      ])
      expect(policyFromConfig({ permission: { bash: 'allow' } })).toEqual([
        { action: 'bash', resource: '*', effect: 'allow' },
      ])
      expect(
        policyFromConfig({ permission: { bash: { 'git *': 'allow', 'rm -rf *': 'deny' } } })
      ).toEqual([
        { action: 'bash', resource: 'git *', effect: 'allow' },
        { action: 'bash', resource: 'rm -rf *', effect: 'deny' },
      ])
    })

    it('has no rules when there is no permission block', () => {
      expect(policyFromConfig({})).toEqual([])
      expect(policyFromConfig(undefined)).toEqual([])
      expect(policyFromConfig({ permission: { bash: 'maybe' } })).toEqual([])
    })

    it('reads the rules of the configuration files on this machine', () => {
      const path = configFile({ permission: { bash: { 'git *': 'allow' } } })
      expect(readPolicyFromConfigs([path])).toEqual([
        { action: 'bash', resource: 'git *', effect: 'allow' },
      ])
    })

    it('reads a file that is not there as no rules at all', () => {
      expect(readPolicyFromConfigs(['/tmp/opencode-pty-does-not-exist.json'])).toEqual([])
    })
  })

  describe('the decision', () => {
    const rules: PolicyRule[] = [
      { action: 'bash', resource: 'git *', effect: 'allow' },
      { action: 'bash', resource: 'rm -rf *', effect: 'deny' },
      { action: 'bash', resource: '*', effect: 'ask' },
    ]

    it('lets the most specific pattern win', () => {
      expect(evaluatePolicy(rules, 'bash', 'git status', 'deny')).toBe('allow')
      expect(evaluatePolicy(rules, 'bash', 'rm -rf /', 'deny')).toBe('deny')
    })

    it('falls back to the caller for a resource that matches nothing', () => {
      expect(evaluatePolicy([], 'bash', 'ls', 'deny')).toBe('deny')
      expect(evaluatePolicy([], 'bash', 'ls', 'allow')).toBe('allow')
    })
  })

  describe('the authorizer', () => {
    it('allows what the rules allow', async () => {
      const authorizer = new PolicyAuthorizer({
        rules: [{ action: 'bash', resource: 'git *', effect: 'allow' }],
      })
      await expect(authorizer.checkCommand('git', ['status'])).resolves.toBeUndefined()
    })

    it('refuses what the rules deny', async () => {
      const authorizer = new PolicyAuthorizer({
        rules: [{ action: 'bash', resource: 'rm -rf *', effect: 'deny' }],
      })
      await expect(authorizer.checkCommand('rm', ['-rf', '/'])).rejects.toThrow(
        'is denied by the permission policy'
      )
    })

    // A rule that wants a human, on a route that has none: the command does not
    // run, and the message says why.
    it('refuses what the rules would want a human to approve', async () => {
      const authorizer = new PolicyAuthorizer({
        rules: [{ action: 'bash', resource: 'npm *', effect: 'ask' }],
      })
      await expect(authorizer.checkCommand('npm', ['install'])).rejects.toThrow('needs approval')
    })

    it('allows what nobody wrote a rule about, unless the route says otherwise', async () => {
      const lenient = new PolicyAuthorizer({ rules: [] })
      await expect(lenient.checkCommand('ls', [])).resolves.toBeUndefined()

      const strict = new PolicyAuthorizer({ rules: [], defaultEffect: 'deny' })
      await expect(strict.checkCommand('ls', [])).rejects.toThrow('denied by the permission policy')
    })

    it('checks a working directory outside the project under its own action', async () => {
      const authorizer = new PolicyAuthorizer({
        rules: [{ action: 'external_directory', resource: '*', effect: 'deny' }],
      })
      await expect(authorizer.checkWorkdir('/elsewhere')).rejects.toThrow('external_directory')
    })
  })
})
