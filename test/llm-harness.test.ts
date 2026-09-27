import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'

const NEWLINE = String.fromCharCode(10)

import { join } from 'node:path'
import { evaluateRun, type ScenarioOutcome } from './llm/evaluate.ts'
import { emptyTranscript, finalAnswer, parseEventStream, totalUsage } from './llm/events.ts'
import {
  buildFacts,
  type CheckResult,
  countCalls,
  type RunFacts,
  reportedGeometry,
} from './llm/facts.ts'
import {
  collectOfferedCursors,
  collectPtyCalls,
  collectShellCommands,
  extractCallsFromSource,
  extractExecuteCode,
  findClosingParen,
  isPtyToolName,
  readNumberField,
  readStringField,
  sawEndOfBufferClaim,
  sawTruncationMarker,
} from './llm/pty-calls.ts'
import { formatOutcome, formatScenarioList, formatSummary } from './llm/report.ts'
import {
  DEFAULT_MODEL,
  MODEL_ENV,
  main,
  parseArgs,
  resolveModel,
  runOnce,
  selectScenarios,
} from './llm/run.ts'
import { disabledToolsFor, findScenario, SCENARIOS, type Scenario } from './llm/scenarios.ts'
import {
  AUTH_DB_ENV,
  assertPluginBuilt,
  bootstrapCredentials,
  buildHarnessConfig,
  buildRunEnv,
  copyCredentials,
  createWorkspace,
  findRepoRoot,
  pluginDidLoad,
  pluginEntryPoint,
  pluginLoadWarnings,
  readArchivedOutput,
  sourceAuthDatabase,
  writePluginShim,
} from './llm/workspace.ts'

/**
 * The harness is judged on runs that cost money, so its own logic has to be
 * right without one. Everything here is offline: parsing the event stream,
 * pulling tool calls out of the Code Mode sandbox the host wraps them in,
 * building the isolated environment, and deciding a verdict.
 */

function line(value: unknown): string {
  return JSON.stringify(value)
}

function transcriptOf(lines: readonly unknown[]): ReturnType<typeof parseEventStream> {
  return parseEventStream(lines.map(line).join('\n'))
}

describe('event stream', () => {
  it('reads text, tool calls, usage and errors out of NDJSON', () => {
    const transcript = transcriptOf([
      { type: 'step_start', timestamp: 1, sessionID: 'ses_1', part: { id: 'prt_1' } },
      { type: 'text', part: { text: 'first' } },
      {
        type: 'tool_use',
        part: {
          type: 'tool',
          tool: 'execute',
          state: { status: 'completed', input: { code: 'return 1' }, output: 'ok' },
        },
      },
      { type: 'text', part: { text: 'second' } },
      {
        type: 'step_finish',
        part: {
          cost: 0.25,
          tokens: { input: 10, output: 2, reasoning: 3, cache: { read: 4, write: 5 } },
        },
      },
      { type: 'error', error: { type: 'provider.no-route', message: 'nope' } },
    ])

    expect(transcript.sessionId).toBe('ses_1')
    expect(transcript.texts).toEqual(['first', 'second'])
    expect(finalAnswer(transcript)).toBe('first\nsecond')
    expect(transcript.toolCalls).toHaveLength(1)
    expect(transcript.toolCalls[0]?.tool).toBe('execute')
    expect(transcript.steps[0]).toEqual({
      input: 10,
      output: 2,
      reasoning: 3,
      cacheRead: 4,
      cacheWrite: 5,
      cost: 0.25,
    })
    expect(totalUsage(transcript).cost).toBe(0.25)
    expect(transcript.errors).toEqual([{ type: 'provider.no-route', message: 'nope' }])
    expect(transcript.malformed).toEqual([])
  })

  it('keeps a line it cannot parse instead of dropping it silently', () => {
    const transcript = parseEventStream(
      ['{"type":"text","part":{"text":"ok"}}', 'not json at all', '   ', '[1,2,3]'].join('\r\n')
    )
    expect(transcript.texts).toEqual(['ok'])
    expect(transcript.malformed).toEqual(['not json at all', '[1,2,3]'])
  })

  it('survives an empty stream and events with no part', () => {
    expect(parseEventStream('')).toEqual(emptyTranscript())
    const transcript = transcriptOf([{ type: 'step_start' }, { type: 'text' }, { type: 'error' }])
    expect(transcript.texts).toEqual([])
    expect(transcript.errors).toEqual([{ type: '', message: '' }])
  })

  it('adds usage across steps', () => {
    const step = (input: number) => ({
      type: 'step_finish',
      part: { cost: 1, tokens: { input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
    })
    const transcript = transcriptOf([step(1), step(2), step(3)])
    expect(totalUsage(transcript)).toEqual({
      input: 6,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 3,
    })
  })
})

describe('Code Mode call extraction', () => {
  it('finds a call and its balanced arguments', () => {
    const source = 'const r = await tools.pty_read({ id: "pty_x", since: 100000 });\nreturn r;'
    const calls = extractCallsFromSource(source)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.name).toBe('pty_read')
    expect(calls[0]?.args).toBe('{ id: "pty_x", since: 100000 }')
  })

  it('is not fooled by a paren inside a string or a comment', () => {
    const source = [
      '// tools.pty_kill({ id: "decoy" })',
      'const a = await tools.pty_wait({ id: "pty_a", timeoutSeconds: 5 }); // wait ) here',
      "const b = await tools.pty_kill({ id: 'pty_b' });",
    ].join('\n')
    const names = extractCallsFromSource(source).map((call) => call.name)
    expect(names).toEqual(['pty_wait', 'pty_kill'])
    const args = extractCallsFromSource(source)[1]?.args
    expect(args).toBe("{ id: 'pty_b' }")
  })

  it('handles bracket and brace nesting, and the bracket-call form', () => {
    const source = 'await tools["pty_spawn"]({ args: ["-c", "echo (hi) [x] {y}"] });'
    const calls = extractCallsFromSource(source)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.name).toBe('pty_spawn')
    expect(calls[0]?.args).toBe('{ args: ["-c", "echo (hi) [x] {y}"] }')
  })

  it('returns the rest of the source for an unbalanced call', () => {
    expect(findClosingParen('tools.pty_read({ id: 1', 11)).toBe('tools.pty_read({ id: 1'.length)
  })

  it('reads the code property of an execute input, and copes with odd shapes', () => {
    expect(extractExecuteCode('{"code":"return 1"}')).toBe('return 1')
    expect(extractExecuteCode('{"code":"a\\nb"}')).toBe('a\nb')
    expect(extractExecuteCode('{"code":"quote \\" here"}')).toBe('quote " here')
    expect(extractExecuteCode('{"nope":1}')).toBeNull()
    expect(extractExecuteCode('')).toBeNull()
    expect(extractExecuteCode('not json')).toBeNull()
  })
})

describe('pty call collection', () => {
  const execute = (code: string, output = '') => ({
    tool: 'execute',
    input: JSON.stringify({ code }),
    output,
  })

  it('collects pty calls made through the sandbox, in order', () => {
    const calls = collectPtyCalls([
      execute('const r = await tools.pty_spawn({ command: "bash" });'),
      execute('const s = await tools.pty_read({ id: "pty_a" });\nreturn s;'),
      execute('const t = await tools.pty_list();'),
    ])
    expect(calls.map((call) => call.name)).toEqual(['pty_spawn', 'pty_read', 'pty_list'])
    expect(calls.every((call) => call.origin === 'codemode')).toBe(true)
  })

  it('collects natively exposed pty calls too', () => {
    const calls = collectPtyCalls([
      { tool: 'pty_screen', input: '{"id":"pty_a"}', output: '<pty_screen>' },
    ])
    expect(calls).toEqual([
      { name: 'pty_screen', args: '{"id":"pty_a"}', origin: 'native', output: '<pty_screen>' },
    ])
  })

  it('ignores non-pty tools and unknown tool names', () => {
    const calls = collectPtyCalls([
      execute('await tools.shell({ command: "ls" });'),
      execute('x()'),
    ])
    expect(calls).toEqual([])
    expect(isPtyToolName('pty_screen')).toBe(true)
    expect(isPtyToolName('shell')).toBe(false)
  })

  it('collects shell commands from both shapes', () => {
    const commands = collectShellCommands([
      { tool: 'shell', input: '{"command":"sleep 5"}', output: '' },
      {
        tool: 'execute',
        input: JSON.stringify({ code: 'await tools.shell({ command: `ls -la` });' }),
        output: '',
      },
    ])
    expect(commands).toEqual(['sleep 5', 'ls -la'])
  })

  it('reads typed fields out of an argument blob written any way', () => {
    expect(readNumberField('{ since: 100000 }', 'since')).toBe(100000)
    expect(readNumberField('{"since": 12}', 'since')).toBe(12)
    expect(readNumberField("{ 'since': -5 }", 'since')).toBe(-5)
    expect(readNumberField('{ id: "x" }', 'since')).toBeNull()
    expect(readStringField("{ id: 'pty_a' }", 'id')).toBe('pty_a')
    expect(readStringField('{ id: `pty_b` }', 'id')).toBe('pty_b')
    expect(readStringField('{ id: "pty_c" }', 'pattern')).toBeNull()
  })
})

describe('reading the tool output', () => {
  it('collects every cursor a result offered', () => {
    const output = [
      '<pty_output id="pty_a" truncated="true" nextSince="100000" chars="100000/248225">',
      '<pty_output id="pty_a" since="100000" chars="100000/148225" nextSince="200000">',
      '<pty_output id="pty_a" since="200000" chars="48225/48225">',
    ].join('\n')
    expect(collectOfferedCursors(output)).toEqual([100_000, 200_000])
  })

  it('survives the JSON escaping a Code Mode result adds', () => {
    const escaped =
      '{\\"read\\":\\"<pty_output truncated=\\\\\\"true\\\\\\" nextSince=\\\\\\"42\\\\\\">\\"}'
    expect(collectOfferedCursors(escaped)).toEqual([42])
    expect(sawTruncationMarker(escaped)).toBe(true)
  })

  it('tells a cut result from a finished one', () => {
    expect(sawTruncationMarker('<pty_output truncated="true" nextSince="1">')).toBe(true)
    expect(sawTruncationMarker('00002| … [truncated: 0 of 59760 chars]')).toBe(true)
    expect(sawTruncationMarker('<pty_output chars="1/1">')).toBe(false)
    expect(sawEndOfBufferClaim('(End of buffer - 3 lines)')).toBe(true)
    expect(sawEndOfBufferClaim('(Cut mid-result - 6000 of 12162 chars shown)')).toBe(false)
  })

  it('reads the size a spawn result reported', () => {
    expect(reportedGeometry(['<pty_spawned>\nSize: 240x80\n</pty_spawned>'])).toEqual({
      cols: 240,
      rows: 80,
    })
    expect(reportedGeometry(['no size here'])).toBeNull()
  })
})

describe('facts', () => {
  it('recognises a resume with a cursor that was actually offered', () => {
    const transcript = transcriptOf([
      {
        type: 'tool_use',
        part: {
          type: 'tool',
          tool: 'execute',
          state: {
            status: 'completed',
            input: { code: 'await tools.pty_read({ id: "pty_a" })' },
            output: '<pty_output truncated="true" nextSince="6001" chars="6001/12162">',
          },
        },
      },
      {
        type: 'tool_use',
        part: {
          type: 'tool',
          tool: 'execute',
          state: {
            status: 'completed',
            input: { code: 'await tools.pty_read({ id: "pty_a", since: 6001 })' },
            output: '<pty_output since="6001" chars="6161/6161">',
          },
        },
      },
    ])
    const facts = buildFacts(transcript, { pluginLoaded: true, timedOut: false })
    expect(facts.sawCut).toBe(true)
    expect(facts.offeredCursors).toEqual([6001])
    expect(facts.usedSinceValues).toEqual([6001])
    expect(facts.resumedWithOfferedCursor).toBe(true)
  })

  it('does not count a since the model invented', () => {
    const transcript = transcriptOf([
      {
        type: 'tool_use',
        part: {
          type: 'tool',
          tool: 'execute',
          state: {
            status: 'completed',
            input: { code: 'await tools.pty_read({ id: "pty_a", since: 3 })' },
            output: '<pty_output nextSince="9001">',
          },
        },
      },
    ])
    const facts = buildFacts(transcript, { pluginLoaded: true, timedOut: false })
    expect(facts.usedSinceValues).toEqual([3])
    expect(facts.resumedWithOfferedCursor).toBe(false)
  })

  it('records the ways a model can route around the budget', () => {
    const transcript = transcriptOf([
      {
        type: 'tool_use',
        part: {
          type: 'tool',
          tool: 'execute',
          state: {
            status: 'completed',
            input: {
              code: 'await tools.pty_read({ id: "pty_a", maxTokens: 25000, all: true, pattern: "TOK-" })',
            },
            output: '',
          },
        },
      },
    ])
    const facts = buildFacts(transcript, { pluginLoaded: true, timedOut: false })
    expect(facts.raisedReadBudget).toBe(true)
    expect(facts.readUnbounded).toBe(true)
    expect(facts.readWithPattern).toBe(true)
  })

  it('notices a discarded session and a sized spawn', () => {
    const transcript = transcriptOf([
      {
        type: 'tool_use',
        part: {
          type: 'tool',
          tool: 'execute',
          state: {
            status: 'completed',
            input: { code: 'await tools.pty_spawn({ command: "bash", cols: 300, rows: 60 })' },
            output: '<pty_spawned>\nSize: 300x60\n</pty_spawned>',
          },
        },
      },
      {
        type: 'tool_use',
        part: {
          type: 'tool',
          tool: 'execute',
          state: {
            status: 'completed',
            input: { code: 'await tools.pty_kill({ id: "pty_a", cleanup: true })' },
            output: 'killed',
          },
        },
      },
    ])
    const facts = buildFacts(transcript, { pluginLoaded: true, timedOut: false })
    expect(facts.geometryTouched).toBe(true)
    expect(facts.discardedSessions).toHaveLength(1)
    expect(facts.spawnOutputs).toHaveLength(1)
    expect(countCalls(facts.calls, 'pty_spawn')).toBe(1)
  })

  it('does not mistake cleanup: false for a discard', () => {
    const transcript = transcriptOf([
      {
        type: 'tool_use',
        part: {
          type: 'tool',
          tool: 'execute',
          state: {
            status: 'completed',
            input: { code: 'await tools.pty_kill({ id: "pty_a" })' },
            output: 'killed',
          },
        },
      },
    ])
    expect(
      buildFacts(transcript, { pluginLoaded: true, timedOut: false }).discardedSessions
    ).toEqual([])
  })
})

describe('verdicts', () => {
  const maybe = findScenario('truncation-resume')
  if (!maybe) throw new Error('the truncation case is missing')
  const scenario: Scenario = maybe

  const spawnEvent = {
    type: 'tool_use',
    part: {
      type: 'tool',
      tool: 'execute',
      state: {
        status: 'completed',
        input: { code: 'await tools.pty_spawn({ command: "bash", args: ["gen.sh"] })' },
        output: '<pty_spawned>\nSize: 240x80\n</pty_spawned>',
      },
    },
  }

  function evaluate(options: {
    token: string
    cut?: boolean
    resume?: boolean
    escape?: 'all: true' | 'maxTokens' | 'pattern'
    answer?: string
    pluginLoaded?: boolean
    timedOut?: boolean
    errors?: unknown[]
  }) {
    const events: unknown[] = [spawnEvent]
    if (options.cut !== false) {
      events.push({
        type: 'tool_use',
        part: {
          type: 'tool',
          tool: 'execute',
          state: {
            status: 'completed',
            input: { code: 'await tools.pty_read({ id: "pty_a" })' },
            output: '<pty_output truncated="true" nextSince="6001" chars="6001/12162">',
          },
        },
      })
    }
    if (options.escape !== undefined) {
      const args =
        options.escape === 'all: true'
          ? '{ id: "pty_a", all: true }'
          : options.escape === 'maxTokens'
            ? '{ id: "pty_a", maxTokens: 20000 }'
            : '{ id: "pty_a", pattern: "TOK-" }'
      events.push({
        type: 'tool_use',
        part: {
          type: 'tool',
          tool: 'execute',
          state: {
            status: 'completed',
            input: { code: `await tools.pty_read(${args})` },
            output: `<pty_output all="true">TOK-${options.token}`,
          },
        },
      })
    }
    // Whatever the route, the last thing a pty tool handed over is the token, so
    // the "seen through a pty" check has something to hold.
    if (options.cut === false) {
      events.push({
        type: 'tool_use',
        part: {
          type: 'tool',
          tool: 'execute',
          state: {
            status: 'completed',
            input: { code: 'await tools.pty_read({ id: "pty_a", maxTokens: 20000 })' },
            output: `<pty_output>TOK-${options.token}</pty_output>`,
          },
        },
      })
    }
    if (options.resume === true) {
      events.push({
        type: 'tool_use',
        part: {
          type: 'tool',
          tool: 'execute',
          state: {
            status: 'completed',
            input: { code: 'await tools.pty_read({ id: "pty_a", since: 6001 })' },
            output: `<pty_output since="6001">TOK-${options.token}`,
          },
        },
      })
    }
    events.push({ type: 'text', part: { text: options.answer ?? `TOK-${options.token}` } })
    for (const error of options.errors ?? []) events.push(error)
    return evaluateRun({
      scenario,
      token: options.token,
      transcript: transcriptOf(events),
      producedOutput: `TOK-${options.token}`,
      pluginLoaded: options.pluginLoaded ?? true,
      timedOut: options.timedOut ?? false,
      durationMs: 1000,
      exitCode: 0,
      model: 'test/model',
      warnings: [],
      workspaceRoot: '/tmp/none',
    })
  }

  it('passes when the model saw a cut and resumed with the cursor it was offered', () => {
    const outcome = evaluate({ token: 'abc123', resume: true })
    expect(outcome.status).toBe('pass')
    expect(outcome.checks.every((check) => check.status === 'pass')).toBe(true)
  })

  it('fails when the answer is wrong even though the mechanism was right', () => {
    const outcome = evaluate({ token: 'abc123', resume: true, answer: 'I could not find it' })
    expect(outcome.status).toBe('fail')
    const answer = outcome.checks.find((check) => check.name === 'answer-is-right')
    expect(answer?.status).toBe('fail')
    expect(answer?.detail).toContain('missing TOK-abc123')
  })

  it('passes on a documented escape hatch but records which one', () => {
    const outcome = evaluate({ token: 'abc123', resume: false, escape: 'all: true' })
    const kept = outcome.checks.find((entry) => entry.name === 'kept-reading-after-a-cut')
    const route = outcome.checks.find((entry) => entry.name === 'recovered-with')
    // The cut was not mistaken for the end of the data, which is the promise.
    expect(kept?.status).toBe('pass')
    // Which route it took is measured, not gated: `maxTokens` and `all` are
    // advertised in the tool description next to the cursor, so an advisory skip
    // must not demote the case.
    expect(route?.status).toBe('skip')
    expect(route?.advisory).toBe(true)
    expect(route?.detail).toContain('all: true')
    expect(outcome.status).toBe('pass')
  })

  it('fails when the model answered with a cut as the last thing it saw', () => {
    const outcome = evaluate({ token: 'abc123', resume: false, answer: 'probably TOK-abc123' })
    const kept = outcome.checks.find((entry) => entry.name === 'kept-reading-after-a-cut')
    expect(kept?.status).toBe('fail')
    expect(kept?.detail).toContain('answered anyway')
  })

  it('passes when the model looked again, whichever route it took', () => {
    const outcome = evaluate({ token: 'abc123', resume: false, escape: 'maxTokens' })
    expect(outcome.checks.find((entry) => entry.name === 'kept-reading-after-a-cut')?.status).toBe(
      'pass'
    )
  })

  it('reports, rather than fails, when the model never met a cut', () => {
    // Raising `maxTokens` on the first read is allowed, so nothing gets cut and
    // there is nothing to resume from. The premise is advisory, so the case
    // still has an opinion: the token came out of a pty tool result.
    const outcome = evaluate({ token: 'abc123', cut: false, answer: `TOK-abc123` })
    const cut = outcome.checks.find((check) => check.name === 'truncated-result-encountered')
    expect(cut?.status).toBe('skip')
    expect(cut?.advisory).toBe(true)
    expect(outcome.status).toBe('pass')
  })

  it('rejects an answer no pty session ever printed', () => {
    // The archive is the ground truth: if the token is not in what a session
    // wrote, the model invented it or got it from somewhere else entirely.
    const invented = evaluateRun({
      scenario,
      token: 'abc123',
      transcript: transcriptOf([spawnEvent, { type: 'text', part: { text: 'TOK-abc123' } }]),
      producedOutput: 'nothing like the token here',
      pluginLoaded: true,
      timedOut: false,
      durationMs: 1000,
      exitCode: 0,
      model: 'test/model',
      warnings: [],
      workspaceRoot: '/tmp/none',
    })
    const answer = invented.checks.find((check) => check.name === 'answer-is-right')
    expect(answer?.status).toBe('fail')
    expect(answer?.detail).toContain('no pty session ever printed it')
    expect(invented.status).toBe('fail')
  })

  it('notes when the model reported the token without reading it back', () => {
    // A pty session printed it, but the model answered from the fixture's
    // source, which the shell tool lets it read. Reported, not failed: the case
    // is about the anti-patterns, and this is a different question.
    const readTheSource = evaluateRun({
      scenario,
      token: 'abc123',
      transcript: transcriptOf([
        spawnEvent,
        {
          type: 'tool_use',
          part: {
            type: 'tool',
            tool: 'shell',
            state: { status: 'completed', input: { command: 'cat gen.sh' }, output: 'TOK-abc123' },
          },
        },
        { type: 'text', part: { text: 'TOK-abc123' } },
      ]),
      producedOutput: 'TOK-abc123',
      pluginLoaded: true,
      timedOut: false,
      durationMs: 1000,
      exitCode: 0,
      model: 'test/model',
      warnings: [],
      workspaceRoot: '/tmp/none',
    })
    const sawIt = readTheSource.checks.find((check) => check.name === 'saw-it-in-a-pty-result')
    expect(sawIt?.status).toBe('skip')
    expect(sawIt?.advisory).toBe(true)
    expect(sawIt?.detail).toContain('fixture source')
    expect(readTheSource.status).toBe('pass')
  })

  it('fails when the plugin never loaded, and when the run was killed', () => {
    expect(evaluate({ token: 'a', pluginLoaded: false }).checks[0]?.status).toBe('fail')
    const timedOut = evaluate({ token: 'abc123', timedOut: true })
    expect(timedOut.checks.find((check) => check.name === 'run-finished')?.status).toBe('fail')
    const errored = evaluate({
      token: 'abc123',
      errors: [{ type: 'error', error: { message: 'x' } }],
    })
    expect(errored.checks.find((check) => check.name === 'run-finished')?.detail).toContain(
      'error events'
    )
  })

  it('records what the run cost and which model it cost it to', () => {
    const outcome = evaluate({ token: 'abc123' })
    expect(outcome.metrics.model).toBe('test/model')
    expect(outcome.metrics.durationMs).toBe(1000)
    expect(outcome.metrics.ptyToolCalls).toBeGreaterThan(0)
  })
})

describe('model resolution', () => {
  it('prefers the flag, then the environment, then the default', () => {
    expect(resolveModel('flag/model', { [MODEL_ENV]: 'env/model' })).toBe('flag/model')
    expect(resolveModel(undefined, { [MODEL_ENV]: 'env/model' })).toBe('env/model')
    expect(resolveModel('  ', { [MODEL_ENV]: 'env/model' })).toBe('env/model')
    expect(resolveModel(undefined, {})).toBe(DEFAULT_MODEL)
    expect(resolveModel(undefined, { [MODEL_ENV]: '' })).toBe(DEFAULT_MODEL)
    expect(DEFAULT_MODEL).toBe('opencode-go/space-bunny-free')
  })

  it('parses the runner flags', () => {
    const options = parseArgs([
      '--scenario=truncation-resume',
      '--scenario=smoke',
      '--repeat=3',
      '--model=anthropic/claude-haiku-4-5',
      '--timeout=90',
      '--keep',
      '--list',
    ])
    expect(options.scenarioIds).toEqual(['truncation-resume', 'smoke'])
    expect(options.repeat).toBe(3)
    expect(options.model).toBe('anthropic/claude-haiku-4-5')
    expect(options.timeoutMs).toBe(90_000)
    expect(options.keep).toBe(true)
    expect(options.list).toBe(true)
  })

  it('falls back to safe values for junk flags', () => {
    const options = parseArgs(['--repeat=nope', '--timeout=1'])
    expect(options.repeat).toBe(1)
    expect(options.timeoutMs).toBe(10_000)
    expect(() => parseArgs(['--nonsense=1'])).toThrow(/unknown flag/)
  })
})

describe('scenarios', () => {
  it('never leaks the token into the prompt', () => {
    for (const scenario of SCENARIOS) {
      const token = 'deadbeefdeadbeef'
      expect(scenario.prompt(token)).not.toContain(token)
    }
  })

  it('only leaves the shell tool in reach where the anti-pattern needs it', () => {
    for (const scenario of SCENARIOS) {
      const disabled = disabledToolsFor(scenario)
      if (scenario.id === 'no-polling') {
        expect(disabled).not.toContain('shell')
      } else {
        expect(disabled).toContain('shell')
        expect(disabled).toContain('bash')
      }
    }
  })
})

describe('isolated environment', () => {
  it('finds the package root and its built V2 entrypoint', () => {
    const root = findRepoRoot()
    // The root is wherever this checkout happens to live. Asserting its directory
    // name - which this test did, expecting the path to end in "opencode-pty" -
    // makes the suite pass or fail on where somebody cloned the repository, and
    // it is normally worked on from a worktree whose name carries the task. What
    // identifies the root is the manifest in it, so assert that.
    const manifest: unknown = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    expect(manifest).toMatchObject({ name: 'opencode-pty' })
    expect(pluginEntryPoint(root)).toBe(join(root, 'dist', 'src', 'v2', 'index.js'))
    expect(() => assertPluginBuilt(root)).not.toThrow()
  })

  it('refuses to run against a missing build, and says how to make one', () => {
    const empty = mkdtempSync(join(tmpdir(), 'pty-no-build-'))
    try {
      expect(() => assertPluginBuilt(empty)).toThrow(/bun run build:prod/)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it('writes a config that points at a directory and names the model', () => {
    const config = buildHarnessConfig({
      pluginDir: '/tmp/ws/plugin',
      model: 'test/model',
      disabledTools: ['shell'],
    })
    expect(config.plugin).toEqual(['file:///tmp/ws/plugin'])
    expect(config.small_model).toBe('test/model')
    const agent = config.agent['pty-harness'] as { mode?: string }
    expect(agent.mode).toBe('primary')
    expect(JSON.stringify(config)).toContain('"shell":false')
  })

  it('strips every inherited opencode and XDG variable', () => {
    const workspace = {
      root: '/tmp/ws',
      projectDir: '/tmp/ws/project',
      configPath: '/tmp/ws/config/opencode/opencode.json',
      dataHome: '/tmp/ws/data',
      stateHome: '/tmp/ws/state',
      ptyStateDir: '/tmp/ws/pty-state',
      pluginLogPath: '/tmp/ws/state/opencode/opencode-pty.log',
      hostLogPath: '/tmp/ws/data/opencode/log/opencode.log',
      env: {},
      warnings: [],
      cleanup: () => {},
    }
    const env = buildRunEnv({
      workspace,
      base: {
        PATH: '/usr/bin',
        HOME: '/home/someone',
        OPENCODE_CONFIG: '/leak/opencode.json',
        OPENCODE_SERVER_PASSWORD: 'leak',
        XDG_DATA_HOME: '/leak',
        XDG_CONFIG_HOME: '/leak',
        KEEP_ME: 'yes',
      },
    })
    expect(env.PATH).toBe('/usr/bin')
    expect(env.HOME).toBe('/home/someone')
    expect(env.KEEP_ME).toBe('yes')
    // Every opencode variable the harness passes is one it chose; the two the
    // caller's environment carried are gone.
    const allowed = new Set([
      'OPENCODE_CONFIG_DIR',
      'OPENCODE_DISABLE_AUTOUPDATE',
      'OPENCODE_DISABLE_FILEWATCHER',
      'OPENCODE_DISABLE_PROJECT_CONFIG',
      'OPENCODE_PTY_STATE_DIR',
    ])
    for (const key of Object.keys(env)) {
      if (key.startsWith('OPENCODE_')) expect(allowed.has(key)).toBe(true)
    }
    expect(env.OPENCODE_CONFIG).toBeUndefined()
    expect(env.OPENCODE_SERVER_PASSWORD).toBeUndefined()
    // The run must be in the throwaway project, not wherever the harness was
    // launched from: the host reads PWD, not getcwd().
    expect(env.PWD).toBe('/tmp/ws/project')
    expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1')
    expect(env.XDG_DATA_HOME).toBe('/tmp/ws/data')
  })

  it('points at the host database for credentials, and can be overridden', () => {
    expect(sourceAuthDatabase({ HOME: '/home/someone' })).toBe(
      '/home/someone/.local/share/opencode/opencode.db'
    )
    expect(sourceAuthDatabase({ HOME: '/home/someone', XDG_DATA_HOME: '/data' })).toBe(
      '/data/opencode/opencode.db'
    )
    expect(sourceAuthDatabase({ HOME: '/h', [AUTH_DB_ENV]: '/explicit.db' })).toBe('/explicit.db')
  })
})

const CREDENTIAL_DDL =
  'create table credential (id text primary key, integration_id text, label text, value text, ' +
  'connector_id text, method_id text, active text, time_created text, time_updated text)'

type CredentialRow = [
  string,
  string,
  string,
  string,
  string | null,
  string | null,
  string | null,
  string,
  string,
]

function seedCredentialDatabase(path: string, rows: CredentialRow[]): void {
  const db = new Database(path)
  try {
    db.run(CREDENTIAL_DDL)
    for (const row of rows) {
      db.run('insert into credential values (?, ?, ?, ?, ?, ?, ?, ?, ?)', row)
    }
  } finally {
    db.close()
  }
}

describe('credential bootstrap', () => {
  it('reports a missing source instead of throwing', () => {
    const result = copyCredentials('/nowhere/opencode.db', '/nowhere/other.db')
    expect(result.copied).toBe(0)
    expect(result.problem).toContain('no opencode database')
  })

  it('copies the credential table and leaves the source alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pty-cred-'))
    const source = join(dir, 'source.db')
    const target = join(dir, 'target.db')
    try {
      seedCredentialDatabase(source, [
        ['cred_1', 'opencode-go', 'default', '{"type":"key"}', null, null, null, '1', '2'],
      ])
      // The host creates the target and runs its own migrations, so the table is
      // already there; the harness only has to fill it.
      seedCredentialDatabase(target, [])

      expect(copyCredentials(source, target)).toEqual({ copied: 1, problem: null })

      const into = new Database(target)
      const rows = into
        .query<{ id: string; integration_id: string }, []>(
          'select id, integration_id, value from credential'
        )
        .all()
      expect(rows).toHaveLength(1)
      expect(rows[0]?.integration_id).toBe('opencode-go')
      into.close()

      // The source is opened read-only: same row count, and no journal left
      // behind next to somebody else's database.
      const reopened = new Database(source, { readonly: true })
      expect(
        reopened.query<{ n: number }, []>('select count(*) as n from credential').get()?.n
      ).toBe(1)
      reopened.close()
      expect(existsSync(`${source}-journal`)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('is idempotent, so a repeated bootstrap does not collide', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pty-cred-'))
    const source = join(dir, 'source.db')
    const target = join(dir, 'target.db')
    try {
      seedCredentialDatabase(source, [
        ['cred_1', 'opencode-go', 'default', '{"type":"key"}', null, null, null, '1', '2'],
      ])
      seedCredentialDatabase(target, [])
      expect(copyCredentials(source, target).copied).toBe(1)
      expect(copyCredentials(source, target).copied).toBe(1)
      const into = new Database(target)
      expect(into.query<{ n: number }, []>('select count(*) as n from credential').get()?.n).toBe(1)
      into.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('says so when the source has no credential table', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pty-cred-'))
    const source = join(dir, 'source.db')
    const target = join(dir, 'target.db')
    try {
      new Database(source).run('create table other (id text)')
      seedCredentialDatabase(target, [])
      const result = copyCredentials(source, target)
      expect(result.copied).toBe(0)
      expect(result.problem).toContain('no credential table')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('names the target when the host has not migrated it yet', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pty-cred-'))
    const source = join(dir, 'source.db')
    const target = join(dir, 'target.db')
    try {
      seedCredentialDatabase(source, [
        ['cred_1', 'opencode-go', 'default', '{"type":"key"}', null, null, null, '1', '2'],
      ])
      new Database(target).run('create table other (id text)')
      const result = copyCredentials(source, target)
      expect(result.copied).toBe(0)
      // Without this the run would die later on "Model unavailable", which
      // points at the model instead of at the missing migration.
      expect(result.problem).toContain('no such table')
      expect(result.problem).toContain(target)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('plugin load detection', () => {
  it('is false without a log and true with a setup line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pty-detect-'))
    const workspace = {
      root: dir,
      projectDir: join(dir, 'project'),
      configPath: join(dir, 'config.json'),
      dataHome: join(dir, 'data'),
      stateHome: join(dir, 'state'),
      ptyStateDir: join(dir, 'pty'),
      pluginLogPath: join(dir, 'opencode-pty.log'),
      hostLogPath: join(dir, 'opencode.log'),
      env: {},
      warnings: [],
      cleanup: () => {},
    }
    try {
      expect(pluginDidLoad(workspace)).toBe(false)
      Bun.write(
        workspace.pluginLogPath,
        '2026-01-01T00:00:00.000Z INFO v2 exit notifications enabled\n'
      )
      expect(pluginDidLoad(workspace)).toBe(true)

      Bun.write(
        workspace.hostLogPath,
        [
          'nothing here',
          'message="failed to load plugin" target=/x',
          'message="configured plugin path must be a directory" target=/y',
          'message="Plugin must export a default definition"',
        ].join('\n')
      )
      expect(pluginLoadWarnings(workspace)).toHaveLength(3)
      Bun.write(workspace.hostLogPath, 'all good\n')
      expect(pluginLoadWarnings(workspace)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('says nothing about a host log that is not there', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pty-detect-'))
    try {
      expect(pluginLoadWarnings({ hostLogPath: join(dir, 'nope.log') } as never)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('plugin shim', () => {
  it('is a package directory whose entrypoint is the built V2 default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pty-shim-'))
    const repoRoot = findRepoRoot()
    try {
      writePluginShim(join(dir, 'plugin'), repoRoot)
      const shim = readFileSync(join(dir, 'plugin', 'index.ts'), 'utf8')
      expect(shim).toBe(`export { default } from ${JSON.stringify(pluginEntryPoint(repoRoot))}\n`)
      const manifest = JSON.parse(readFileSync(join(dir, 'plugin', 'package.json'), 'utf8')) as {
        main: string
        type: string
      }
      // `main: index.ts` is what makes the host load the V2 default. A bare file
      // path is rejected outright with "must be a directory".
      expect(manifest.main).toBe('index.ts')
      expect(manifest.type).toBe('module')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('running a session', () => {
  it('builds the host command line the harness documents', async () => {
    const { sessionArgs } = await import('./llm/run-session.ts')
    const args = sessionArgs({
      workspace: {} as never,
      env: {},
      model: 'test/model',
      prompt: 'do the thing',
    })
    expect(args).toEqual([
      'run',
      '--format=json',
      '--standalone',
      '--auto',
      '--agent',
      'pty-harness',
      '--model',
      'test/model',
      'do the thing',
    ])
  })

  it('kills the whole process group when the wall clock runs out', async () => {
    // A stand-in for the opencode binary that never finishes on its own and
    // leaves a grandchild behind, which is the shape a runaway run has: the CLI,
    // the server it spawned, and the PTY sessions under that.
    const dir = mkdtempSync(join(tmpdir(), 'pty-timeout-'))
    const binary = join(dir, 'fake-opencode')
    const pidFile = join(dir, 'grandchild.pid')
    Bun.write(
      binary,
      [
        '#!/bin/sh',
        'sh -c \'echo $$ > "$FAKE_GRANDCHILD_PID"; exec sleep 600\' &',
        'echo \'{"type":"text","part":{"text":"partial"}}\'',
        'wait',
        '',
      ].join('\n')
    )
    chmodSync(binary, 0o755)
    const previous = process.env.FAKE_GRANDCHILD_PID
    process.env.FAKE_GRANDCHILD_PID = pidFile
    try {
      const { runSession } = await import('./llm/run-session.ts')
      const result = await runSession({
        workspace: { root: dir, projectDir: dir } as never,
        env: Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] => entry[1] !== undefined
          )
        ),
        model: 'test/model',
        prompt: 'unused',
        timeoutMs: 1500,
        binary,
      })

      expect(result.timedOut).toBe(true)
      expect(result.durationMs).toBeGreaterThanOrEqual(1400)
      // Whatever arrived before the kill is still parsed, so a timed-out run
      // reports what the model managed to do instead of nothing at all.
      expect(result.transcript.texts).toEqual(['partial'])
      expect(result.exitCode === null || result.exitCode !== 0).toBe(true)

      const grandchild = Number(readFileSync(pidFile, 'utf8').trim())
      expect(Number.isInteger(grandchild)).toBe(true)
      // The negative pid in killGroup targets the group, so the grandchild goes
      // with it. A leftover here is a process still running after the harness
      // gave up, which is the outcome this whole mechanism exists to prevent.
      let alive = true
      for (let attempt = 0; attempt < 20 && alive; attempt += 1) {
        await Bun.sleep(100)
        try {
          process.kill(grandchild, 0)
        } catch {
          alive = false
        }
      }
      expect(alive).toBe(false)
      expect(existsSync(join(dir, 'run.ndjson'))).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.FAKE_GRANDCHILD_PID
      else process.env.FAKE_GRANDCHILD_PID = previous
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)
})

describe('reporting', () => {
  function outcomeOf(
    overrides: Partial<ScenarioOutcome> & { scenarioId: string }
  ): ScenarioOutcome {
    return {
      title: 'a case',
      model: 'test/model',
      token: 'abc',
      status: 'pass',
      checks: [],
      facts: {} as never,
      metrics: {
        durationMs: 12_340,
        model: 'test/model',
        inputTokens: 100,
        outputTokens: 20,
        reasoningTokens: 5,
        cacheReadTokens: 7,
        cost: 0.125,
        steps: 3,
        ptyToolCalls: 4,
        hostToolCalls: 6,
        shellCommands: 1,
        exitCode: 0,
        timedOut: false,
      },
      answer: '',
      warnings: [],
      workspaceRoot: '/tmp/none',
      ...overrides,
    }
  }

  it('names the model and the cost on every outcome', () => {
    const text = formatOutcome(outcomeOf({ scenarioId: 'smoke' }))
    expect(text).toContain('PASS         smoke  model=test/model')
    expect(text).toContain('12.3s  steps=3  tokens=125')
    expect(text).toContain('cost=0.1250')
    expect(text).toContain('pty calls=4 in 6 host tool call(s); shell=1')
  })

  it('marks each check and repeats any warning', () => {
    const text = formatOutcome(
      outcomeOf({
        scenarioId: 'smoke',
        warnings: ['host: configured plugin path must be a directory'],
        checks: [
          { name: 'a', status: 'pass', detail: 'fine' },
          { name: 'b', status: 'fail', detail: 'not fine' },
          { name: 'c', status: 'skip', detail: 'never got there' },
        ],
      })
    )
    expect(text).toContain('[PASS] a: fine')
    expect(text).toContain('[FAIL] b: not fine')
    expect(text).toContain('[SKIP] c: never got there')
    expect(text).toContain('warn: host: configured plugin path must be a directory')
  })

  it('summarises pass rate per case and names the model that produced it', () => {
    const text = formatSummary([
      outcomeOf({ scenarioId: 'smoke' }),
      outcomeOf({ scenarioId: 'smoke', status: 'fail' }),
      outcomeOf({ scenarioId: 'truncation-resume', status: 'inconclusive', model: 'other/model' }),
    ])
    expect(text).toContain('smoke                  1/2 passed (50%)')
    expect(text).toContain('truncation-resume      0/1 passed (0%)  1 inconclusive')
    expect(text).toContain('3 run(s) on test/model, other/model')
  })

  it('lists the cases without spending anything', () => {
    const text = formatScenarioList(SCENARIOS)
    for (const scenario of SCENARIOS) {
      expect(text).toContain(scenario.id)
      expect(text).toContain(scenario.intent)
    }
  })
})

describe('the runner', () => {
  function stubOutcome(scenarioId: string, status: ScenarioOutcome['status']): ScenarioOutcome {
    return evaluateRun({
      scenario: findScenario(scenarioId) as Scenario,
      token: 'abc123',
      transcript: transcriptOf([{ type: 'text', part: { text: 'TOK-abc123' } }]),
      producedOutput: 'TOK-abc123',
      pluginLoaded: true,
      timedOut: false,
      durationMs: 1000,
      exitCode: 0,
      model: 'test/model',
      warnings: [],
      workspaceRoot: '/tmp/none',
    }).checks.length >= 0
      ? ({
          ...evaluateRun({
            scenario: findScenario(scenarioId) as Scenario,
            token: 'abc123',
            transcript: transcriptOf([{ type: 'text', part: { text: 'TOK-abc123' } }]),
            pluginLoaded: true,
            timedOut: false,
            durationMs: 1000,
            exitCode: 0,
            model: 'test/model',
            warnings: [],
            workspaceRoot: '/tmp/none',
          }),
          status,
        } as ScenarioOutcome)
      : ({} as ScenarioOutcome)
  }

  it('runs every selected case the requested number of times and exits non-zero on any red', async () => {
    const seen: string[] = []
    let out = ''
    const code = await main({
      argv: ['--scenario=smoke', '--scenario=truncation-resume', '--repeat=2', '--model=x/y'],
      execute: async (scenario, _options, model) => {
        seen.push(`${scenario.id}@${model}`)
        return {
          outcome: stubOutcome(scenario.id, seen.length === 1 ? 'pass' : 'fail'),
          session: {} as never,
          workspace: {} as never,
        }
      },
      write: (text) => {
        out += text
      },
    })
    expect(seen).toEqual([
      'smoke@x/y',
      'smoke@x/y',
      'truncation-resume@x/y',
      'truncation-resume@x/y',
    ])
    expect(code).toBe(1)
    expect(out).toContain('model: x/y')
    expect(out).toContain('smoke run 2/2')
    expect(out).toContain('=== summary ===')
  })

  it('exits zero when everything passed', async () => {
    const code = await main({
      argv: ['--scenario=smoke'],
      execute: async (scenario) => ({
        outcome: stubOutcome(scenario.id, 'pass'),
        session: {} as never,
        workspace: {} as never,
      }),
      write: () => {},
    })
    expect(code).toBe(0)
  })

  it('lists without running anything', async () => {
    let executed = false
    let out = ''
    const code = await main({
      argv: ['--list'],
      execute: async () => {
        executed = true
        throw new Error('should not run')
      },
      write: (text) => {
        out += text
      },
    })
    expect(code).toBe(0)
    expect(executed).toBe(false)
    expect(out).toContain('truncation-resume')
  })

  it('reports a bad flag and an unknown case without spending anything', async () => {
    let out = ''
    expect(
      await main({ argv: ['--wat'], execute: async () => ({}) as never, write: (t) => (out += t) })
    ).toBe(2)
    expect(out).toContain('unknown flag --wat')
    expect(() => selectScenarios(['nope'])).toThrow(/unknown scenario 'nope'/)
    expect(selectScenarios([]).length).toBe(SCENARIOS.length)
  })
})

describe('scenario verdicts', () => {
  function factsFor(calls: Array<{ code: string; output?: string }>, answer = ''): RunFacts {
    return buildFacts(
      transcriptOf([
        ...calls.map((call) => ({
          type: 'tool_use',
          part: {
            type: 'tool',
            tool: 'execute',
            state: {
              status: 'completed',
              input: { code: call.code },
              output: call.output ?? '',
            },
          },
        })),
        { type: 'text', part: { text: answer } },
      ]),
      { pluginLoaded: true, timedOut: false }
    )
  }

  function runChecks(id: string, facts: RunFacts): CheckResult[] {
    const scenario = findScenario(id)
    if (!scenario?.checks) throw new Error(`${id} has no checks`)
    return scenario.checks(facts)
  }

  it('truncation: passes only on a real resume, and names the alternatives otherwise', () => {
    const cut = factsFor([
      {
        code: 'await tools.pty_read({ id: "pty_a" })',
        output: '<pty_output truncated="true" nextSince="6001">',
      },
    ])
    expect(runChecks('truncation-resume', cut)[0]?.status).toBe('pass')

    const resumed = factsFor([
      {
        code: 'await tools.pty_read({ id: "pty_a" })',
        output: '<pty_output truncated="true" nextSince="6001">',
      },
      { code: 'await tools.pty_read({ id: "pty_a", since: 6001 })' },
    ])
    const good = runChecks('truncation-resume', resumed)
    expect(good.every((check) => check.status === 'pass')).toBe(true)

    const shortcut = factsFor([
      {
        code: 'await tools.pty_read({ id: "pty_a" })',
        output: '<pty_output truncated="true" nextSince="6001">',
      },
      { code: 'await tools.pty_read({ id: "pty_a", all: true, pattern: "TOK-" })' },
    ])
    const bad = runChecks('truncation-resume', shortcut)
    expect(bad[1]?.name).toBe('kept-reading-after-a-cut')
    expect(bad[1]?.status).toBe('pass')
    expect(bad[2]?.name).toBe('recovered-with')
    expect(bad[2]?.status).toBe('skip')
    expect(bad[2]?.detail).toContain('all: true')

    // The failure this case exists to catch: a cut was the last thing the model
    // saw and it answered anyway.
    const stopped = factsFor([
      {
        code: 'await tools.pty_read({ id: "pty_a" })',
        output: '<pty_output truncated="true" nextSince="6001">',
      },
    ])
    const stale = runChecks('truncation-resume', stopped)
    expect(stale[1]?.status).toBe('fail')
    expect(stale[1]?.detail).toContain('answered anyway')
  })

  it('screen: wants pty_screen, and says what it used instead', () => {
    const used = factsFor([{ code: 'await tools.pty_screen({ id: "pty_a" })' }])
    expect(runChecks('screen-not-escapes', used)[0]?.status).toBe('pass')

    const notUsed = factsFor([
      { code: 'await tools.pty_read({ id: "pty_a" })' },
      { code: 'await tools.pty_read({ id: "pty_a", offset: 1 })' },
    ])
    const check = runChecks('screen-not-escapes', notUsed)[0]
    expect(check?.status).toBe('fail')
    expect(check?.detail).toContain('2 pty_read, 0 pty_screen')
  })

  it('geometry: accepts cols on spawn or a resize, and nothing else', () => {
    const spawned = factsFor([
      { code: 'await tools.pty_spawn({ command: "bash", cols: 320, rows: 60 })' },
    ])
    expect(runChecks('geometry-not-broken', spawned)[0]?.status).toBe('pass')

    const resized = factsFor([{ code: 'await tools.pty_resize({ id: "pty_a", cols: 400 })' }])
    expect(runChecks('geometry-not-broken', resized)[0]?.status).toBe('pass')

    const tooSmall = factsFor([{ code: 'await tools.pty_spawn({ command: "bash", cols: 120 })' }])
    const attempted = runChecks('geometry-not-broken', tooSmall)[0]
    expect(attempted?.status).toBe('fail')
    expect(attempted?.detail).toContain('never reached 300')

    const untouched = factsFor([{ code: 'await tools.pty_spawn({ command: "bash" })' }])
    const none = runChecks('geometry-not-broken', untouched)[0]
    expect(none?.status).toBe('fail')
    expect(none?.detail).toContain('stayed at the fallback size')
  })

  it('geometry: wants the size it set reported back, not the prompt number', () => {
    // The model set 320x50 and said "301 characters" rather than "300", because
    // it counted `RECORD-0N ` as 11 characters. That is a better answer than
    // echoing the prompt back, and the check must not punish it.
    const facts = factsFor(
      [
        {
          code: 'await tools.pty_spawn({ command: "bash", args: ["gen.sh"], cols: 320, rows: 50 })',
          output: '<pty_spawned>\nSize: 320x50\n</pty_spawned>',
        },
      ],
      'Each record is 301 characters, so I set the session to 320 columns by 50 rows.'
    )
    const checks = runChecks('geometry-not-broken', facts)
    expect(checks[0]?.name).toBe('sized-the-session')
    expect(checks[0]?.status).toBe('pass')
    expect(checks[1]?.name).toBe('reported-the-size')
    expect(checks[1]?.status).toBe('pass')
    expect(checks[1]?.detail).toContain('320')
  })

  it('polling: catches a sleep loop, a read loop and a discarded session', () => {
    const clean = factsFor([
      { code: 'await tools.pty_spawn({ command: "bash", args: ["gen.sh"], notifyOnExit: true })' },
      { code: 'await tools.pty_wait({ id: "pty_a", timeoutSeconds: 20 })' },
      { code: 'await tools.pty_read({ id: "pty_a" })' },
    ])
    expect(runChecks('no-polling', clean).every((check) => check.status === 'pass')).toBe(true)

    const slept = factsFor([
      { code: 'await tools.shell({ command: "sleep 6" })' },
      { code: 'await tools.pty_read({ id: "pty_a" })' },
    ])
    expect(runChecks('no-polling', slept)[0]?.status).toBe('fail')

    const looped = factsFor([
      { code: 'await tools.pty_wait({ id: "pty_a" })' },
      { code: 'await tools.pty_read({ id: "pty_a" })' },
      { code: 'await tools.pty_read({ id: "pty_a" })' },
      { code: 'await tools.pty_read({ id: "pty_a" })' },
    ])
    const reads = runChecks('no-polling', looped)[1]
    expect(reads?.status).toBe('fail')
    expect(reads?.detail).toContain('polling loop')

    const discarded = factsFor([
      { code: 'await tools.pty_wait({ id: "pty_a" })' },
      { code: 'await tools.pty_kill({ id: "pty_a", cleanup: true })' },
    ])
    expect(runChecks('no-polling', discarded)[2]?.status).toBe('fail')

    const neverWaited = factsFor([
      { code: 'await tools.pty_spawn({ command: "bash", args: ["gen.sh"] })' },
      { code: 'await tools.pty_read({ id: "pty_a" })' },
    ])
    expect(runChecks('no-polling', neverWaited)[3]?.detail).toContain('neither pty_wait')
  })
})

describe('workspace lifecycle', () => {
  it('creates everything a run needs inside one directory and removes it', () => {
    const workspace = createWorkspace({ label: 'unit' })
    try {
      expect(existsSync(workspace.projectDir)).toBe(true)
      expect(existsSync(join(workspace.root, 'plugin', 'index.ts'))).toBe(true)
      expect(existsSync(join(workspace.root, 'config', 'opencode', 'opencode.json'))).toBe(false)
      expect(workspace.ptyStateDir.startsWith(workspace.root)).toBe(true)
    } finally {
      const root = workspace.root
      workspace.cleanup()
      expect(existsSync(root)).toBe(false)
    }
  })

  it('keeps the directory when asked to', () => {
    const workspace = createWorkspace({ keep: true, label: 'unit-keep' })
    try {
      workspace.cleanup()
      expect(existsSync(workspace.root)).toBe(true)
    } finally {
      rmSync(workspace.root, { recursive: true, force: true })
    }
  })

  it('bootstraps a database and reports how many credentials it copied', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pty-boot-'))
    const binary = join(dir, 'fake-opencode')
    // A host that creates the database and exits, which is all the bootstrap
    // needs: the model id does not resolve, so no tokens are spent.
    const seed = join(dir, 'seed.db')
    Bun.write(
      binary,
      [
        '#!/bin/sh',
        `cp "${seed}" "$XDG_DATA_HOME/opencode/opencode.db"`,
        'echo \'{"type":"error","error":{"message":"Model unavailable"}}\'',
        '',
      ].join('\n')
    )
    chmodSync(binary, 0o755)
    try {
      seedCredentialDatabase(seed, [
        ['cred_1', 'opencode-go', 'default', '{"type":"key"}', null, null, null, '1', '2'],
      ])
      const workspace = createWorkspace({ label: 'unit-boot' })
      try {
        const env = buildRunEnv({ workspace })
        const copied = bootstrapCredentials(workspace, env, binary, seed)
        expect(copied).toBe(1)
        expect(workspace.warnings).toEqual([])
        const db = new Database(join(workspace.dataHome, 'opencode', 'opencode.db'), {
          readonly: true,
        })
        expect(db.query<{ n: number }, []>('select count(*) as n from credential').get()?.n).toBe(1)
        db.close()
      } finally {
        workspace.cleanup()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('warns instead of throwing when the host binary is not there', () => {
    const workspace = createWorkspace({ label: 'unit-nobin' })
    try {
      const env = buildRunEnv({ workspace })
      const copied = bootstrapCredentials(
        workspace,
        env,
        join(workspace.root, 'no-such-binary'),
        join(workspace.root, 'no-such-source.db')
      )
      expect(copied).toBe(0)
      expect(workspace.warnings.join(' ')).toContain('database bootstrap failed')
      expect(workspace.warnings.join(' ')).toContain('credentials not copied')
    } finally {
      workspace.cleanup()
    }
  })
})

describe('one run end to end, without a model', () => {
  /**
   * A stand-in host that plays back a fixed transcript. The token in the answer
   * is read out of the generated program, so the assertion is still "the answer
   * came from the output", and the whole pipeline - workspace, config, plugin
   * shim, credential bootstrap, transcript, verdict - is exercised for free.
   */
  const FAKE_HOST = `#!/usr/bin/env bun
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
if (args.includes('bootstrap-does-not-exist')) {
  const dir = join(process.env.XDG_DATA_HOME, 'opencode')
  mkdirSync(dir, { recursive: true })
  copyFileSync(process.env.SEED_DB, join(dir, 'opencode.db'))
  process.exit(1)
}

const script = readFileSync('gen.sh', 'utf8')
const token = /TOK-([0-9a-f]{16})/.exec(script)?.[1] ?? 'no-token'
const call = (code, output) => ({
  type: 'tool_use',
  part: { type: 'tool', tool: 'execute', state: { status: 'completed', input: { code }, output } },
})
const events = [
  call('await tools.pty_spawn({ command: "bash", args: ["gen.sh"] })', '<pty_spawned>\\nSize: 240x80\\n</pty_spawned>'),
  call('await tools.pty_read({ id: "pty_a" })', '<pty_output truncated="true" nextSince="6001">'),
  call('await tools.pty_read({ id: "pty_a", since: 6001 })', '<pty_output since="6001">TOK-' + token + '</pty_output>'),
  { type: 'text', part: { text: 'TOK-' + token } },
]
process.stdout.write(events.map((event) => JSON.stringify(event)).join('\\n') + '\\n')
const logDir = join(process.env.XDG_STATE_HOME, 'opencode')
mkdirSync(logDir, { recursive: true })
writeFileSync(join(logDir, 'opencode-pty.log'), '2026-01-01T00:00:00.000Z INFO v2 exit notifications enabled\\n')

// The archive is where the harness looks to tell "a session printed this" from
// "the model read the fixture source and said it".
const archive = join(process.env.OPENCODE_PTY_STATE_DIR, 'pty_a')
mkdirSync(archive, { recursive: true })
writeFileSync(join(archive, 'output.log'), 'TOK-' + token + '\\n')
`

  function seedHost(dir: string): { binary: string; seed: string } {
    const binary = join(dir, 'fake-opencode')
    const seed = join(dir, 'seed.db')
    Bun.write(binary, FAKE_HOST)
    chmodSync(binary, 0o755)
    seedCredentialDatabase(seed, [
      ['cred_1', 'opencode-go', 'default', '{"type":"key"}', null, null, null, '1', '2'],
    ])
    return { binary, seed }
  }

  it('runs a case, judges it, and leaves nothing behind', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pty-e2e-'))
    const { binary, seed } = seedHost(dir)
    const previous = process.env.SEED_DB
    process.env.SEED_DB = seed
    const scenario = findScenario('truncation-resume') as Scenario
    let root = ''
    try {
      const result = await runOnce(
        scenario,
        {
          scenarioIds: [],
          repeat: 1,
          model: 'test/model',
          timeoutMs: 30_000,
          keep: true,
          list: false,
          artifacts: '',
          binary,
        },
        'test/model',
        findRepoRoot()
      )
      root = result.workspace.root
      expect(result.outcome.status).toBe('pass')
      expect(result.outcome.model).toBe('test/model')
      expect(result.outcome.checks.map((check) => check.name)).toContain('kept-reading-after-a-cut')
      expect(result.outcome.checks.find((check) => check.name === 'recovered-with')?.status).toBe(
        'pass'
      )
      expect(result.outcome.metrics.ptyToolCalls).toBe(3)
      expect(result.session.rawStdout).toContain('pty_spawn')
      // The plugin log the run produced is what decided `plugin-loaded`.
      expect(result.outcome.checks[0]?.name).toBe('plugin-loaded')
      expect(result.outcome.checks[0]?.status).toBe('pass')
    } finally {
      rmSync(dir, { recursive: true, force: true })
      if (root !== '') rmSync(root, { recursive: true, force: true })
      if (previous === undefined) delete process.env.SEED_DB
      else process.env.SEED_DB = previous
    }
  }, 60_000)

  it('removes the workspace even when the host blows up', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pty-e2e-'))
    const binary = join(dir, 'exploding-opencode')
    Bun.write(binary, '#!/bin/sh\nexit 3\n')
    chmodSync(binary, 0o755)
    const previous = process.env.SEED_DB
    process.env.SEED_DB = join(dir, 'no-seed.db')
    try {
      const scenario = findScenario('smoke') as Scenario
      const result = await runOnce(
        scenario,
        {
          scenarioIds: [],
          repeat: 1,
          model: 'test/model',
          timeoutMs: 30_000,
          keep: false,
          list: false,
          artifacts: '',
          binary,
        },
        'test/model',
        findRepoRoot()
      )
      expect(result.outcome.status).toBe('fail')
      // Nothing ran, so the case failed on its own floor rather than passing.
      expect(
        result.outcome.checks.find((check) => check.name === 'spawned-a-session')?.status
      ).toBe('fail')
      expect(existsSync(result.workspace.root)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
      if (previous === undefined) delete process.env.SEED_DB
      else process.env.SEED_DB = previous
    }
  }, 60_000)
})

describe('keeping the raw stream', () => {
  it('writes a transcript that outlives the workspace only when asked', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pty-keep-'))
    const binary = join(dir, 'fake-opencode')
    Bun.write(binary, '#!/bin/sh\necho \'{"type":"text","part":{"text":"kept"}}\'\n')
    chmodSync(binary, 0o755)
    const artifacts = join(dir, 'artifacts')
    const workspace = {
      root: dir,
      projectDir: dir,
      configPath: join(dir, 'config.json'),
      dataHome: join(dir, 'data'),
      stateHome: join(dir, 'state'),
      ptyStateDir: join(dir, 'pty'),
      pluginLogPath: join(dir, 'opencode-pty.log'),
      hostLogPath: join(dir, 'opencode.log'),
      env: {},
      warnings: [],
      cleanup: () => {},
    }
    try {
      const { runSession } = await import('./llm/run-session.ts')
      const without = await runSession({
        workspace: workspace as never,
        env: {},
        model: 'test/model',
        prompt: 'unused',
        timeoutMs: 20_000,
        binary,
      })
      expect(without.transcript.texts).toEqual(['kept'])
      // No artifact directory was created, so the conversation went nowhere.
      expect(existsSync(artifacts)).toBe(false)

      const with_ = await runSession({
        workspace: workspace as never,
        env: {},
        model: 'test/model',
        prompt: 'unused',
        timeoutMs: 20_000,
        binary,
        artifacts,
      })
      const written = readdirSync(artifacts).filter((name) => name.endsWith('.ndjson'))
      expect(written).toHaveLength(1)
      expect(readFileSync(join(artifacts, written[0] as string), 'utf8')).toContain('kept')
      expect(with_.transcript.texts).toEqual(['kept'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})

describe('the invariant the read budget exists to keep', () => {
  it('fails a run whose result said cut and finished at the same time', () => {
    const contradiction = transcriptOf([
      {
        type: 'tool_use',
        part: {
          type: 'tool',
          tool: 'execute',
          state: {
            status: 'completed',
            input: { code: 'await tools.pty_read({ id: "pty_a" })' },
            // The exact shape the old silent clamp produced.
            output:
              '<pty_output id="pty_a" truncated="true" nextSince="6001" chars="6001/12162">\n00002| cut …\n\n(End of buffer - 1 lines, 12162 chars)\n</pty_output>',
          },
        },
      },
      { type: 'text', part: { text: 'TOK-abc123' } },
    ])
    const outcome = evaluateRun({
      scenario: findScenario('truncation-resume') as Scenario,
      token: 'abc123',
      transcript: contradiction,
      pluginLoaded: true,
      timedOut: false,
      durationMs: 1000,
      exitCode: 0,
      model: 'test/model',
      warnings: [],
      workspaceRoot: '/tmp/none',
    })
    const check = outcome.checks.find((entry) => entry.name === 'no-result-contradicts-itself')
    expect(check?.status).toBe('fail')
    expect(outcome.status).toBe('fail')
  })

  it('accepts a plain "End of buffer" on a result that was not cut', () => {
    const finished = transcriptOf([
      {
        type: 'tool_use',
        part: {
          type: 'tool',
          tool: 'execute',
          state: {
            status: 'completed',
            input: { code: 'await tools.pty_read({ id: "pty_a" })' },
            output:
              '<pty_output chars="27/27">\\n00001| done\\n\\n(End of buffer - 1 lines)\\n</pty_output>',
          },
        },
      },
      { type: 'text', part: { text: 'TOK-abc123' } },
    ])
    const facts = buildFacts(finished, { pluginLoaded: true, timedOut: false })
    expect(facts.sawEndOfBufferClaim).toBe(true)
    expect(facts.contradictoryResult).toBe(false)
  })
})

describe('reading the archive', () => {
  it('returns what the sessions printed and ignores the metadata', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pty-archive-'))
    try {
      // OPENCODE_PTY_STATE_DIR replaces the whole sessions root, so the
      // per-session directories sit directly under it.
      const session = join(dir, 'pty_a')
      mkdirSync(session, { recursive: true })
      writeFileSync(join(session, 'output.log'), ['line one', 'line two', ''].join(NEWLINE))
      // Metadata describes the session; it never contains what it printed.
      writeFileSync(
        join(session, 'meta.json'),
        JSON.stringify({ id: 'pty_a', command: 'bash gen.sh' })
      )
      expect(readArchivedOutput(dir)).toContain('line one')
      expect(readArchivedOutput(dir)).toContain('line two')
      expect(readArchivedOutput(dir)).not.toContain('gen.sh')

      // The layout without the override, which nests under sessions/.
      const nested = join(dir, 'sessions', 'pty_b')
      mkdirSync(nested, { recursive: true })
      writeFileSync(join(nested, 'output.log'), 'nested output')
      expect(readArchivedOutput(join(dir, 'sessions'))).toContain('nested output')

      // A directory with no sessions at all is not an error.
      expect(readArchivedOutput(join(dir, 'nothing-here'))).toBe('')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the fourth anti-pattern', () => {
  const maybe = findScenario('truncation-resume')
  if (!maybe) throw new Error('the truncation case is missing')
  const scenario: Scenario = maybe
  const spawnEvent = {
    type: 'tool_use',
    part: {
      type: 'tool',
      tool: 'execute',
      state: {
        status: 'completed',
        input: { code: 'await tools.pty_spawn({ command: "bash" })' },
        output: ['<pty_spawned>', 'Size: 240x80', '</pty_spawned>'].join(NEWLINE),
      },
    },
  }

  it('fails a run that threw a session away', () => {
    const outcome = evaluateRun({
      scenario,
      token: 'abc123',
      transcript: transcriptOf([
        spawnEvent,
        {
          type: 'tool_use',
          part: {
            type: 'tool',
            tool: 'execute',
            state: {
              status: 'completed',
              input: { code: 'await tools.pty_kill({ id: "pty_a", cleanup: true })' },
              output: '<pty_killed>Killed: pty_a (session removed)</pty_killed>',
            },
          },
        },
        { type: 'text', part: { text: 'TOK-abc123' } },
      ]),
      producedOutput: 'TOK-abc123',
      pluginLoaded: true,
      timedOut: false,
      durationMs: 1000,
      exitCode: 0,
      model: 'test/model',
      warnings: [],
      workspaceRoot: '/tmp/none',
    })
    const check = outcome.checks.find((entry) => entry.name === 'no-session-discarded')
    expect(check?.status).toBe('fail')
    expect(check?.detail).toContain('cleanup: true')
    expect(outcome.status).toBe('fail')
  })

  it('passes when the session survives the kill', () => {
    const outcome = evaluateRun({
      scenario,
      token: 'abc123',
      transcript: transcriptOf([
        spawnEvent,
        {
          type: 'tool_use',
          part: {
            type: 'tool',
            tool: 'execute',
            state: {
              status: 'completed',
              input: { code: 'await tools.pty_kill({ id: "pty_a" })' },
              output: '<pty_killed>Killed: pty_a (session retained for log access)</pty_killed>',
            },
          },
        },
        { type: 'text', part: { text: 'TOK-abc123' } },
      ]),
      producedOutput: 'TOK-abc123',
      pluginLoaded: true,
      timedOut: false,
      durationMs: 1000,
      exitCode: 0,
      model: 'test/model',
      warnings: [],
      workspaceRoot: '/tmp/none',
    })
    expect(outcome.checks.find((entry) => entry.name === 'no-session-discarded')?.status).toBe(
      'pass'
    )
    expect(outcome.status).toBe('pass')
  })

  it('still counts a token it was shown even after the archive is gone', () => {
    // cleanup: true deletes the archived session, so the archive cannot be the
    // only evidence that a session printed the token.
    const outcome = evaluateRun({
      scenario,
      token: 'abc123',
      transcript: transcriptOf([
        spawnEvent,
        {
          type: 'tool_use',
          part: {
            type: 'tool',
            tool: 'execute',
            state: {
              status: 'completed',
              input: { code: 'await tools.pty_read({ id: "pty_a" })' },
              output: '<pty_output>TOK-abc123</pty_output>',
            },
          },
        },
        { type: 'text', part: { text: 'TOK-abc123' } },
      ]),
      producedOutput: '',
      pluginLoaded: true,
      timedOut: false,
      durationMs: 1000,
      exitCode: 0,
      model: 'test/model',
      warnings: [],
      workspaceRoot: '/tmp/none',
    })
    expect(outcome.checks.find((entry) => entry.name === 'answer-is-right')?.status).toBe('pass')
  })
})
