import { afterAll, afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { manager } from '../src/plugin/pty/manager.ts'
import { ptyRead } from '../src/plugin/pty/tools/read.ts'
import { ptyScreen } from '../src/plugin/pty/tools/screen.ts'
import { ptySpawn } from '../src/plugin/pty/tools/spawn.ts'
import { disabledToolsFor, newToken, SCENARIOS, type Scenario } from './llm/scenarios.ts'

/**
 * The fixtures have to keep biting.
 *
 * Every LLM case is only worth its tokens while its premise holds: the budget
 * still cuts, the frame is only on the screen, the record still does not fit in
 * the fallback width, the program still prints nothing until it is done. A
 * fixture that quietly stops being hard leaves the case passing for the wrong
 * reason, which is worse than a red one. These checks cost nothing and run in
 * the ordinary unit suite.
 */

const ctx = {
  sessionID: 'llm-harness-fixture',
  messageID: 'msg',
  agent: 'agent',
  abort: new AbortController().signal,
  metadata: () => {},
  ask: async () => {},
  directory: '/tmp',
  worktree: '/tmp',
}

const workspaces: string[] = []
const sessions: string[] = []

function text(result: unknown): string {
  if (typeof result === 'string') return result
  throw new Error(`unexpected tool result: ${JSON.stringify(result).slice(0, 200)}`)
}

interface Prepared {
  scenario: Scenario
  token: string
  dir: string
  sessionId: string
  env: Record<string, string>
}

async function prepareAsync(scenario: Scenario, waitMs = 1500): Promise<Prepared> {
  const token = newToken()
  const dir = mkdtempSync(join(tmpdir(), 'pty-llm-fixture-'))
  workspaces.push(dir)
  const context = {
    projectDir: dir,
    env: {} as Record<string, string>,
    disabledTools: disabledToolsFor(scenario),
  }
  scenario.prepare(context, token)
  for (const [key, value] of Object.entries(context.env)) process.env[key] = value
  const spawned = text(
    await ptySpawn.execute(
      {
        command: 'bash',
        args: ['gen.sh'],
        description: 'harness fixture check',
        workdir: dir,
        // The isolated run always gets the 240x80 fallback because no web
        // client has ever connected. In the full suite another test leaves a
        // client-reported size behind, so the size is stated here rather than
        // assumed - otherwise this case tests whatever the previous test did.
        cols: 240,
        rows: 80,
      },
      ctx as never
    )
  )
  const sessionId = /ID: (\S+)/.exec(spawned)?.[1]
  if (sessionId === undefined) throw new Error(`no session id in ${spawned}`)
  sessions.push(sessionId)
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs))
  return { scenario, token, dir, sessionId, env: context.env }
}

function read(id: string, args: Record<string, unknown> = {}): Promise<string> {
  return ptyRead.execute({ id, ...args }, ctx as never).then(text)
}

function screen(id: string): Promise<string> {
  return ptyScreen.execute({ id }, ctx as never).then(text)
}

afterEach(() => {
  for (const key of ['PTY_READ_MAX_TOKENS']) delete process.env[key]
})

afterAll(() => {
  for (const id of sessions) {
    try {
      manager.kill(id, true)
    } catch {
      // Already gone.
    }
  }
  manager.clearAllSessions()
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true })
})

describe('LLM harness fixtures', () => {
  it('covers every scenario the runner offers', () => {
    expect(SCENARIOS.length).toBeGreaterThan(0)
    for (const scenario of SCENARIOS) {
      const token = newToken()
      expect(scenario.prompt(token)).toContain('gen.sh')
      // The prompt must never hand the model the answer.
      expect(scenario.prompt(token)).not.toContain(token)
      // A case with nothing to assert in the answer has to say so with a check
      // of its own, or it is asserting nothing.
      const checks = scenario.checks
        ? scenario.checks({
            answer: '',
            calls: [],
            toolOutput: '',
            ptyToolOutput: '',
            offeredCursors: [],
            resumedWithOfferedCursor: false,
            usedSinceValues: [],
            sawCut: false,
            sawEndOfBufferClaim: false,
            contradictoryResult: false,
            readAfterFirstCut: false,
            readsAfterFirstCut: 0,
            raisedReadBudget: false,
            readUnbounded: false,
            readWithPattern: false,
            shellCommands: [],
            spawnOutputs: [],
            geometryTouched: false,
            discardedSessions: [],
            timedOut: false,
            errors: [],
            pluginLoaded: true,
          })
        : []
      // Either the answer is checked, or the case carries a check of its own.
      expect(scenario.answerMustContain(token).length + checks.length).toBeGreaterThan(0)
    }
  })

  it('gives every program a bounded runtime, so an abandoned run leaves nothing', () => {
    for (const scenario of SCENARIOS) {
      const dir = mkdtempSync(join(tmpdir(), 'pty-llm-fixture-'))
      workspaces.push(dir)
      scenario.prepare({ projectDir: dir, env: {}, disabledTools: [] }, newToken())
      const script = readFileSync(join(dir, 'gen.sh'), 'utf8')
      expect(script).toContain('sleep ')
      // The longest sleep a case may contain. Anything longer is a run that can
      // outlive its own timeout.
      const sleeps = [...script.matchAll(/sleep (\d+)/g)].map((match) => Number(match[1]))
      expect(Math.max(...sleeps)).toBeLessThanOrEqual(20)
      // A case that sleeps must be a case that never runs a build or a cleanup.
      expect(script).not.toMatch(/\brm\b|\bmkdir\b|\bbun run\b|\bgit\b/)
    }
  })

  it('cuts the truncation fixture and keeps the token out of the first read', async () => {
    const scenario = SCENARIOS.find((entry) => entry.id === 'truncation-resume')
    if (!scenario) throw new Error('the truncation case is missing')
    const { token, sessionId } = await prepareAsync(scenario)

    const first = await read(sessionId)
    expect(first).toContain('truncated="true"')
    expect(first).toMatch(/nextSince="(\d+)"/)
    expect(first).not.toContain(`TOK-${token}`)

    // Even a targeted search is cut, so there is no way around the cursor.
    const searched = await read(sessionId, { pattern: 'TOK-' })
    expect(searched).toContain('truncated="true"')
    expect(searched).not.toContain(`TOK-${token}`)

    const cursor = Number(/nextSince="(\d+)"/.exec(first)?.[1])
    const resumed = await read(sessionId, { since: cursor })
    expect(resumed).toContain(`TOK-${token}`)
  }, 30_000)

  it('puts the current frame on the screen and not in a readable line', async () => {
    const scenario = SCENARIOS.find((entry) => entry.id === 'screen-not-escapes')
    if (!scenario) throw new Error('the screen case is missing')
    const { sessionId } = await prepareAsync(scenario)

    const flat = await read(sessionId)
    expect(flat).toMatch(/chars="\d+\/\d+"/)
    // The whole session is one logical line: the "huge character count, no lines"
    // shape the tool descriptions point at pty_screen.
    expect(flat).toMatch(/Total lines: 1|End of buffer - 1 lines/)

    const rendered = await screen(sessionId)
    expect(rendered).toContain('FRAME-5 ROW-07')
    expect(rendered).not.toContain('FRAME-1 ROW-07')
  }, 30_000)

  it('makes the geometry fixture wider than the fallback terminal', async () => {
    const scenario = SCENARIOS.find((entry) => entry.id === 'geometry-not-broken')
    if (!scenario) throw new Error('the geometry case is missing')
    const { dir, sessionId } = await prepareAsync(scenario)

    const script = readFileSync(join(dir, 'gen.sh'), 'utf8')
    expect(script).toContain('seq 1 290')
    expect(scenario.prompt(newToken())).toContain('300')
    const flat = await read(sessionId)
    expect(flat).toContain('TERMINAL-COLS=240')
    // Three 300 character records cannot each fit on one 240 column row, so the
    // screen shows six rows for three records. That is the case only worth
    // running while the model has to act on the size.
    const rendered = await screen(sessionId)
    const recordRows = rendered.split('\n').filter((line) => /^0\d\| (RECORD-|z)/.test(line))
    expect(recordRows.length).toBe(6)
  }, 30_000)

  it('keeps the polling fixture silent until it is done', async () => {
    const scenario = SCENARIOS.find((entry) => entry.id === 'no-polling')
    if (!scenario) throw new Error('the polling case is missing')
    const { token, sessionId } = await prepareAsync(scenario, 800)

    const early = await read(sessionId)
    expect(early).toContain('No output available')
    expect(early).not.toContain(`FINISHED-${token}`)
  }, 30_000)
})
