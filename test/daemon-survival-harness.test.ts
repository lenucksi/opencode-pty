import { afterAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  archivedSessionsWithToken,
  daemonPaths,
  evaluatePhaseA,
  evaluatePhaseB,
  isAlive,
  parseSurvivalArgs,
  phaseAPrompt,
  phaseBPrompt,
  ptyToolNamesUsed,
  readPid,
  survivalUsage,
} from './llm/daemon-survival.ts'
import type { Transcript } from './llm/events.ts'

const roots: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'daemon-survival-unit-'))
  roots.push(root)
  return root
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function transcript(overrides: Partial<Transcript> = {}): Transcript {
  return {
    events: [],
    malformed: [],
    texts: [],
    toolCalls: [],
    steps: [],
    errors: [],
    sessionId: null,
    ...overrides,
  }
}

function call(tool: string, output: string, input = '') {
  return { tool, status: 'completed', input, output }
}

describe('daemonPaths', () => {
  it('derives the socket from XDG_RUNTIME_DIR and the archive from OPENCODE_PTY_STATE_DIR', () => {
    const paths = daemonPaths({
      XDG_RUNTIME_DIR: '/run/user/1',
      OPENCODE_PTY_STATE_DIR: '/state/sessions',
    })
    expect(paths.socket).toBe('/run/user/1/opencode-pty/ptyd.sock')
    expect(paths.pidFile).toBe('/run/user/1/opencode-pty/ptyd.pid')
    expect(paths.stateDir).toBe('/state/sessions')
  })

  it('falls back to the XDG state home when no state dir is set', () => {
    const paths = daemonPaths({ XDG_RUNTIME_DIR: '/run', XDG_STATE_HOME: '/state' })
    expect(paths.stateDir).toBe('/state/opencode/opencode-pty/sessions')
  })
})

describe('readPid', () => {
  it('returns null for a missing file', () => {
    expect(readPid(join(tempRoot(), 'missing.pid'))).toBeNull()
  })

  it('returns null for a file that is not a positive integer', () => {
    const root = tempRoot()
    const file = join(root, 'bad.pid')
    writeFileSync(file, 'not-a-pid\n')
    expect(readPid(file)).toBeNull()
    writeFileSync(file, '-3\n')
    expect(readPid(file)).toBeNull()
  })

  it('reads a written pid', () => {
    const root = tempRoot()
    const file = join(root, 'good.pid')
    writeFileSync(file, ` ${process.pid} \n`)
    expect(readPid(file)).toBe(process.pid)
  })
})

describe('isAlive', () => {
  it('sees its own process', () => {
    expect(isAlive(process.pid)).toBe(true)
  })

  it('does not see a pid that is not there', () => {
    expect(isAlive(2_147_483_600)).toBe(false)
  })
})

describe('archivedSessionsWithToken', () => {
  it('finds the session whose output.log printed the token, in both layouts', () => {
    const root = tempRoot()
    mkdirSync(join(root, 'pty_a'), { recursive: true })
    writeFileSync(join(root, 'pty_a', 'output.log'), 'hello TOKEN-1\n')
    mkdirSync(join(root, 'sessions', 'pty_b'), { recursive: true })
    writeFileSync(join(root, 'sessions', 'pty_b', 'output.log'), 'also TOKEN-1\n')
    mkdirSync(join(root, 'pty_c'), { recursive: true })
    writeFileSync(join(root, 'pty_c', 'output.log'), 'nothing here\n')

    expect(archivedSessionsWithToken(root, 'TOKEN-1').sort()).toEqual(['pty_a', 'pty_b'])
    expect(archivedSessionsWithToken(root, 'TOKEN-2')).toEqual([])
  })

  it('ignores a missing root', () => {
    expect(archivedSessionsWithToken(join(tempRoot(), 'nope'), 'x')).toEqual([])
  })

  it('includes rotated logs', () => {
    const root = tempRoot()
    mkdirSync(join(root, 'pty_r'), { recursive: true })
    writeFileSync(join(root, 'pty_r', 'output.log.1'), 'TOKEN-3\n')
    expect(archivedSessionsWithToken(root, 'TOKEN-3')).toEqual(['pty_r'])
  })
})

describe('evaluatePhaseA', () => {
  const base = {
    token: 'tok',
    transcript: transcript({ toolCalls: [call('pty_spawn', 'pty_abc')] }),
    socketExists: true,
    pid: 1234,
    pidAlive: true,
    archivedIds: ['pty_abc'],
  }

  it('passes when the daemon is up and one session printed the token', () => {
    const verdict = evaluatePhaseA(base)
    expect(verdict.ok).toBe(true)
    expect(verdict.sessionId).toBe('pty_abc')
  })

  it('names every missing piece', () => {
    const verdict = evaluatePhaseA({
      ...base,
      transcript: transcript(),
      socketExists: false,
      pid: null,
      pidAlive: false,
      archivedIds: [],
    })
    expect(verdict.ok).toBe(false)
    expect(verdict.reasons).toContain('the daemon socket does not exist after the first run')
    expect(verdict.reasons).toContain('the daemon pid file is missing or unreadable')
    expect(verdict.reasons).toContain('the model never called pty_spawn')
    expect(verdict.reasons).toContain('no archived session printed the token, so no PTY ran')
  })

  it('reports a dead pid separately from a missing one', () => {
    const verdict = evaluatePhaseA({ ...base, pidAlive: false })
    expect(verdict.ok).toBe(false)
    expect(verdict.reasons).toContain('the daemon pid 1234 is not running')
  })

  it('refuses to pick a session when more than one printed the token', () => {
    const verdict = evaluatePhaseA({ ...base, archivedIds: ['pty_a', 'pty_b'] })
    expect(verdict.ok).toBe(false)
    expect(verdict.sessionId).toBeNull()
    expect(verdict.reasons.join(' ')).toContain('2 sessions printed the token')
  })

  it('accepts a spawn that only appears in sandbox source', () => {
    const verdict = evaluatePhaseA({
      ...base,
      transcript: transcript({ toolCalls: [call('execute', '', 'await tools.pty_spawn({})')] }),
    })
    expect(verdict.ok).toBe(true)
  })
})

describe('evaluatePhaseB', () => {
  const base = {
    token: 'tok',
    transcript: transcript({
      toolCalls: [call('pty_list', 'pty_abc running'), call('pty_read', 'tok in the buffer')],
    }),
    expectedSessionId: 'pty_abc',
    pidAlive: true,
  }

  it('passes when the second host lists and reads the session', () => {
    expect(evaluatePhaseB(base).ok).toBe(true)
  })

  it('fails when the daemon died', () => {
    const verdict = evaluatePhaseB({ ...base, pidAlive: false })
    expect(verdict.ok).toBe(false)
    expect(verdict.reasons).toContain('the daemon died while the second host ran')
  })

  it('fails without a pty_list call', () => {
    const verdict = evaluatePhaseB({
      ...base,
      transcript: transcript({ toolCalls: [call('pty_read', 'tok')] }),
    })
    expect(verdict.ok).toBe(false)
    expect(verdict.reasons).toContain('the second host never called pty_list')
  })

  it('fails when the session id is absent', () => {
    const verdict = evaluatePhaseB({
      ...base,
      transcript: transcript({ toolCalls: [call('pty_list', 'pty_other running tok')] }),
    })
    expect(verdict.ok).toBe(false)
    expect(verdict.reasons).toContain('the session id pty_abc does not appear in the second run')
  })

  it('fails when nothing is running', () => {
    const verdict = evaluatePhaseB({
      ...base,
      transcript: transcript({
        toolCalls: [call('pty_list', 'pty_abc exited'), call('pty_read', 'tok')],
      }),
    })
    expect(verdict.ok).toBe(false)
    expect(verdict.reasons).toContain('the second run never reported a session as running')
  })

  it('fails when the token was never read back', () => {
    const verdict = evaluatePhaseB({
      ...base,
      transcript: transcript({ toolCalls: [call('pty_list', 'pty_abc running')] }),
    })
    expect(verdict.ok).toBe(false)
    expect(verdict.reasons).toContain('the second run never read the token back out of the buffer')
  })

  it('fails without an expected session id', () => {
    const verdict = evaluatePhaseB({ ...base, expectedSessionId: null })
    expect(verdict.ok).toBe(false)
    expect(verdict.reasons).toContain('the first phase produced no session id to look for')
  })
})

describe('ptyToolNamesUsed', () => {
  it('collects native and sandbox calls without duplicates', () => {
    const names = ptyToolNamesUsed(
      transcript({
        toolCalls: [
          call('pty_spawn', ''),
          call('execute', '', 'await tools.pty_read({})'),
          call('execute', '', 'await tools.pty_read({})'),
        ],
      })
    )
    expect(names).toEqual(['pty_read', 'pty_spawn'])
  })
})

describe('prompts', () => {
  it('phase A names the command and forbids killing it', () => {
    const prompt = phaseAPrompt('tok-1')
    expect(prompt).toContain('pty_spawn')
    expect(prompt).toContain('tok-1')
    expect(prompt).toContain('sleep 300')
    expect(prompt).toContain('Do not call pty_kill')
  })

  it('phase B asks for a list and a read, not for a claim', () => {
    const prompt = phaseBPrompt('tok-2')
    expect(prompt).toContain('pty_list')
    expect(prompt).toContain('tok-2')
    expect(prompt).toContain('Do not kill anything')
  })
})

describe('parseSurvivalArgs', () => {
  it('defaults to a live run with the harness timeout', () => {
    const args = parseSurvivalArgs([])
    expect(args.dryRun).toBe(false)
    expect(args.keep).toBe(false)
    expect(args.timeoutMs).toBe(240_000)
    expect(args.model).toBe('')
  })

  it('reads every flag', () => {
    const args = parseSurvivalArgs([
      '--dry-run',
      '--keep',
      '--model=opencode/x',
      '--timeout=30',
      '--artifacts=/tmp/a',
    ])
    expect(args).toEqual({
      dryRun: true,
      keep: true,
      model: 'opencode/x',
      timeoutMs: 30_000,
      artifacts: '/tmp/a',
      help: false,
    })
  })

  it('ignores a timeout that is not a positive integer', () => {
    expect(parseSurvivalArgs(['--timeout=0']).timeoutMs).toBe(240_000)
    expect(parseSurvivalArgs(['--timeout=abc']).timeoutMs).toBe(240_000)
  })

  it('rejects an unknown flag', () => {
    expect(() => parseSurvivalArgs(['--nope'])).toThrow('unknown flag --nope')
  })

  it('prints usage that names both modes', () => {
    const usage = survivalUsage()
    expect(usage).toContain('--dry-run')
    expect(usage).toContain('--model=')
  })
})
