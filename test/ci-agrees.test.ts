import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { SOCKET_SCAN_COMMAND } from '../scripts/quality/local-gate.ts'

/**
 * The Socket scan runs in two places, and they have to be the same scan.
 *
 * The local gate pins the CLI version in `SOCKET_SCAN_COMMAND`; CI pins it again
 * in `ci.yml`. A second literal is a second thing to forget, and the failure mode
 * is quiet: the local gate keeps passing on the version it knows, CI runs whatever
 * is written there, and nobody notices that the two disagree until a rule starts
 * or stops firing.
 *
 * The same reasoning `usage-docs.test.ts` applies to the skill and the docs dialog:
 * a value that exists in two places needs a test that fails when only one of them
 * is edited.
 */

const repoRoot = join(import.meta.dir, '..')
const ci = readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8')

/** The command as a shell string, the way a workflow would write it. */
function localCommand(): string {
  const [command, ...args] = SOCKET_SCAN_COMMAND
  return [command, ...args].join(' ')
}

describe('the Socket scan is one scan, not two', () => {
  it('CI runs the exact command the local gate runs', () => {
    expect(ci).toContain(`run: ${localCommand()}`)
  })

  it('CI authenticates with the repository secret, never with a literal', () => {
    expect(ci).toContain('SOCKET_SECURITY_API_KEY: ${{ secrets.SOCKET_SECURITY_API_KEY }}')
    // A token written into a workflow is in the history forever. The local config
    // stays where it is; only the secret crosses into GitHub.
    expect(ci).not.toMatch(/sktsec_/)
  })

  it('CI bounds the scan, because it has stalled before', () => {
    // The local gate carries a five-minute ceiling for exactly this reason. Without
    // one here the job would sit for six hours on a bad connection and report
    // nothing.
    expect(ci).toMatch(/socket:[\s\S]*?timeout-minutes:/)
  })

  it('CI does not put the scan in the quality matrix', () => {
    // Six matrix entries would mean six identical scans per push.
    const matrix = /quality: \[([^\]]*)\]/.exec(ci)?.[1] ?? ''
    expect(matrix).not.toContain('socket')
  })

  it('the scan is a job of its own, not a step in an existing one', () => {
    expect(ci).toMatch(/^ {2}socket:$/m)
  })
})

describe('the declared Socket rules match what the repository actually pulls in', () => {
  const socketYml = readFileSync(join(repoRoot, 'socket.yml'), 'utf8')

  it('declares hasNativeCode, and something in the tree is native', () => {
    // bun-pty is a native addon. If the rule ever stopped being true, keeping it
    // would be noise; if a new native dependency arrived, it is exactly right.
    expect(socketYml).toContain('hasNativeCode: true')
    expect(readFileSync(join(repoRoot, 'package.json'), 'utf8')).toContain('bun-pty')
  })

  it('declares gitDependency, and something in the tree comes from a git URL', () => {
    // ghostty-web is pinned to a commit of a fork, not to a registry version, so
    // its content is not covered by a registry's own review.
    expect(socketYml).toContain('gitDependency: true')
    expect(readFileSync(join(repoRoot, 'package.json'), 'utf8')).toMatch(
      /"ghostty-web":\s*"github:/
    )
  })
})
