/**
 * The behaviours worth a real model's opinion, one independently runnable case
 * each.
 *
 * Every case writes its own inert program into the throwaway project directory
 * and asks for a fact that is only obtainable a particular way, so a pass means
 * the model found the path the documentation describes rather than that the tool
 * returned something. Programs are deliberately inert - `printf`, `seq`, `tput`
 * and a bounded `sleep` - and every one ends on its own, so an abandoned run
 * leaves nothing behind.
 *
 * Each case records a random token in its program. The token cannot be guessed,
 * so "the answer contains the token" is a real assertion about what the model
 * saw, and a model that stopped reading early cannot pass by accident.
 */

import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type CheckResult, countCalls, type RunFacts } from './facts.ts'
import { readNumberField } from './pty-calls.ts'

/** Tools no case needs. Removing them keeps the catalogue and the run small. */
const ALWAYS_DISABLED = [
  'webfetch',
  'websearch',
  'write',
  'edit',
  'patch',
  'read',
  'glob',
  'grep',
  'list',
  'todowrite',
  'todoread',
  'task',
] as const

/**
 * A payload line long enough that even a targeted `pattern` read is cut.
 *
 * 9000 characters against a 6000 character budget leaves the token, which sits
 * at the very end, unreachable by anything except resuming with the cursor the
 * result hands back.
 */
const PAYLOAD_CHARS = 9000

export interface ScenarioContext {
  /** Directory the model is told to work in. */
  projectDir: string
  /** Environment overrides the case needs, merged over the harness defaults. */
  env: Record<string, string>
  /** Tools the agent must not have. */
  disabledTools: string[]
}

export interface Scenario {
  id: string
  title: string
  /** What the case is for, printed by the runner. */
  intent: string
  prompt: (token: string) => string
  /** Write whatever the case needs into the throwaway project. */
  prepare: (context: ScenarioContext, token: string) => void
  /** Model-facing answer must contain this. */
  answerMustContain: (token: string) => string[]
  /** Model-facing answer must not contain this. */
  answerMustNotContain: (token: string) => string[]
  /** What the case is specifically about. The generic checks always run too. */
  checks?: (facts: RunFacts) => CheckResult[]
}

function pass(name: string, detail: string): CheckResult {
  return { name, status: 'pass', detail }
}

function fail(name: string, detail: string): CheckResult {
  return { name, status: 'fail', detail }
}

function skip(name: string, detail: string): CheckResult {
  return { name, status: 'skip', detail }
}

function program(context: ScenarioContext, name: string, body: string): void {
  // Executable, so a model that runs `./gen.sh` gets the program rather than a
  // failure. Spawning a non-executable file does not raise: the pty child
  // aborts and its panic text lands in the buffer as
  // "fatal runtime error: assertion failed: output.write(&bytes).is_ok()",
  // which reads as the tool having crashed. Worth knowing, but noise in a case
  // that is about something else.
  writeFileSync(join(context.projectDir, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 })
}

/**
 * The read budget, in tokens, for the case that needs a real cut.
 *
 * Narrowing it is not a shortcut around the slice under test: the same
 * `applyLineBudget` path runs either way, and at 25000 tokens a fixture would
 * have to print more than 100000 characters to be cut at all. What changes is
 * only how much text crosses the wire, which is what makes the case cheap.
 */
const NARROW_READ_BUDGET_TOKENS = '1500'

const truncation: Scenario = {
  id: 'truncation-resume',
  title: 'A cut result is not the end of the data',
  intent:
    'The read budget cuts a result. The model must not read the cut as "that is ' +
    'all of it" and answer there. How it gets the rest - the cursor, a wider ' +
    'budget, an unbounded read - is measured, because the tool offers all three.',
  prompt: () =>
    [
      'The file `gen.sh` in the current directory prints a header line, then one very long',
      'PAYLOAD line, then a few dozen short lines, and then keeps running for a while.',
      '',
      'Start it in a background PTY session and report the exact token at the very end of the',
      'PAYLOAD line. The header line of the output says what the token looks like.',
      '',
      'Do not guess the token and do not report until you have actually seen it in the output.',
      'Then stop.',
    ].join('\n'),
  prepare: (context, token) => {
    context.env.PTY_READ_MAX_TOKENS = NARROW_READ_BUDGET_TOKENS
    const filler = 'x'.repeat(60)
    program(
      context,
      'gen.sh',
      [
        `printf 'PAYLOAD-LINE-STARTS: the token is at the end of this line, TOK-<16 hex>\\n'`,
        `printf 'PAYLOAD-'`,
        `printf 'p%.0s' $(seq 1 ${PAYLOAD_CHARS - 22})`,
        `printf -- '-TOK-${token}\\n'`,
        `for i in $(seq 1 40); do printf 'filler line %02d ${filler}\\n' "$i"; done`,
        'sleep 20',
      ].join('\n')
    )
  },
  answerMustContain: (token: string) => [`TOK-${token}`],
  answerMustNotContain: () => [],
  checks: (facts) => {
    // The premise is reported, not gated. A model may raise `maxTokens` on its
    // first read, and when it does nothing is cut and there is nothing to resume
    // from. Demoting the case for that would make it a coin flip on the model's
    // first move rather than a measurement, so the rate at which the cut path is
    // exercised is reported instead.
    if (!facts.sawCut) {
      return [
        {
          name: 'truncated-result-encountered',
          status: 'skip',
          detail: 'no result the model received was cut, so there was nothing to resume from',
          advisory: true,
        },
      ]
    }
    const checks: CheckResult[] = [
      pass(
        'truncated-result-encountered',
        `${facts.offeredCursors.length} cursor(s) offered: ${facts.offeredCursors.join(', ')}`
      ),
    ]

    // The promise under test is that a cut does not read as the end of the
    // data. That is: after seeing a cut, the model looked again. Treating the
    // cursor as the *only* way would be a harness that fails a model for using a
    // documented escape hatch (`maxTokens`, `all: true`, a narrower `pattern`),
    // and those are advertised in the tool description right next to the cursor.
    if (facts.readAfterFirstCut) {
      checks.push(
        pass(
          'kept-reading-after-a-cut',
          `${facts.readsAfterFirstCut} further pty_read call(s) after the first cut`
        )
      )
    } else {
      checks.push(
        fail(
          'kept-reading-after-a-cut',
          'the last thing the model saw was a cut and it answered anyway'
        )
      )
    }

    // How it recovered is measured, not gated: the distribution is the finding.
    const route = recoveryRoute(facts)
    checks.push({
      name: 'recovered-with',
      status: route === 'cursor' ? 'pass' : 'skip',
      detail:
        route === 'cursor'
          ? 'the nextSince cursor it was offered'
          : `${route}: reached the token without following a cursor, which the tool also allows`,
      // Measured, not gated: `maxTokens`, `all: true` and `pattern` are all
      // advertised next to the cursor, so a model that takes one of them has not
      // done anything wrong.
      advisory: true,
    })
    return checks
  },
}

/**
 * The size the model actually set, read back out of the result the tool
 * returned, has to be in the answer.
 *
 * Not the width from the prompt: a model that sets 320 and then reports the
 * record as 301 characters - because it counted the prefix - has answered
 * better than one that echoes 300 back.
 */
function reportSizeChecks(facts: RunFacts): CheckResult[] {
  const widths = new Set<number>()
  for (const output of facts.spawnOutputs) {
    for (const match of output.matchAll(/Size:\s*(\d+)x(\d+)/g)) {
      widths.add(Number(match[1]))
    }
  }
  if (widths.size === 0) {
    return [skip('reported-the-size', 'no pty_spawn result reported a size')]
  }
  const widest = Math.max(...widths)
  const mentioned = facts.answer.includes(String(widest))
  return [
    mentioned
      ? pass('reported-the-size', `the answer names the ${widest} columns the session got`)
      : {
          name: 'reported-the-size',
          status: 'fail',
          detail: `the session was ${widest} columns and the answer never says so`,
        },
  ]
}

/**
 * How a model got past a cut, in the order the tool description presents the
 * options: follow the cursor, widen the budget, drop the cap, narrow the search.
 */
function recoveryRoute(facts: RunFacts): 'cursor' | 'maxTokens' | 'all: true' | 'pattern' | 'none' {
  if (facts.resumedWithOfferedCursor) return 'cursor'
  if (facts.raisedReadBudget) return 'maxTokens'
  if (facts.readUnbounded) return 'all: true'
  if (facts.readWithPattern) return 'pattern'
  return 'none'
}

const screen: Scenario = {
  id: 'screen-not-escapes',
  title: 'A repainting screen is read with pty_screen',
  intent:
    'The program repaints a screen as one enormous escape-sequence line and never emits a ' +
    'newline, which is the signature the docs name for pty_screen. The model has to reach for it.',
  prompt: () =>
    [
      'The file `gen.sh` in the current directory paints a full screen, repaints it several times',
      'over, and then keeps running.',
      '',
      'Start it in a background PTY session and tell me:',
      '1. the exact text of row 07 of the screen as it looks right now, and',
      '2. which frame number the screen is currently showing.',
      '',
      'Then stop.',
    ].join('\n'),
  prepare: (context) => {
    // No newline anywhere: the whole session is one logical line, which is how
    // real TUI frameworks paint and exactly the "large character count, almost
    // no lines" shape the tool descriptions point at pty_screen. The frames go
    // out back to back so the final state does not depend on when anyone looks.
    program(
      context,
      'gen.sh',
      [
        "printf '\\033[2J\\033[H'",
        'for frame in 1 2 3 4 5; do',
        '  for row in $(seq 1 12); do',
        '    printf \'\\033[%d;1H\' "$row"',
        '    printf \'FRAME-%s ROW-%02d\' "$frame" "$row"',
        '  done',
        'done',
        "printf '\\033[14;1Hholding'",
        'sleep 20',
      ].join('\n')
    )
  },
  answerMustContain: () => ['ROW-07', 'FRAME-5'],
  answerMustNotContain: () => [],
  checks: (facts) => {
    const screens = countCalls(facts.calls, 'pty_screen')
    if (screens > 0) {
      return [pass('reached-pty-screen', `${screens} pty_screen call(s)`)]
    }
    return [
      fail(
        'reached-pty-screen',
        `answered from the flat stream: ${countCalls(facts.calls, 'pty_read')} pty_read, 0 pty_screen`
      ),
    ]
  },
}

const geometry: Scenario = {
  id: 'geometry-not-broken',
  title: 'A session is sized for what the program has to fit',
  intent:
    'Three 300 character records have to stay on one line. The fallback geometry is 240 ' +
    'columns, so the model has to reach for cols or pty_resize and report the real size back.',
  prompt: () =>
    [
      'The file `gen.sh` in the current directory prints three records, each exactly 300',
      'characters long, and then keeps running. Each record has to stay on one line.',
      '',
      'Start it in a background PTY session, make sure of that, and then tell the user the exact',
      'terminal size the session has.',
      '',
      'Then stop.',
    ].join('\n'),
  prepare: (context) => {
    program(
      context,
      'gen.sh',
      [
        `printf 'TERMINAL-COLS=%s\\n' "$(tput cols)"`,
        `for r in 1 2 3; do printf 'RECORD-%02d %s\\n' "$r" "$(printf 'z%.0s' $(seq 1 290))"; done`,
        'sleep 20',
      ].join('\n')
    )
  },
  // No answer requirement: the prompt already says the records are 300
  // characters, so demanding "300" only measures whether the model repeated it.
  // What matters is the size it actually set and reported, checked below.
  answerMustContain: () => [],
  answerMustNotContain: () => [],
  checks: (facts) => {
    const sized = facts.calls.filter((call) => {
      if (call.name === 'pty_resize') return (readNumberField(call.args, 'cols') ?? 0) >= 300
      if (call.name === 'pty_spawn') return (readNumberField(call.args, 'cols') ?? 0) >= 300
      return false
    })
    if (sized.length > 0) {
      return [
        pass(
          'sized-the-session',
          `${sized.length} call(s) set cols >= 300 (${sized.map((call) => call.name).join(', ')})`
        ),
        ...reportSizeChecks(facts),
      ]
    }
    const attempted = facts.calls.filter(
      (call) => call.name === 'pty_resize' || readNumberField(call.args, 'cols') !== null
    )
    return [
      fail(
        'sized-the-session',
        attempted.length > 0
          ? `cols was passed but never reached 300 (${attempted.map((call) => call.name).join(', ')})`
          : 'no cols on pty_spawn and no pty_resize: the session stayed at the fallback size'
      ),
      ...reportSizeChecks(facts),
    ]
  },
}

const noPolling: Scenario = {
  id: 'no-polling',
  title: 'Completion is waited for, not polled for',
  intent:
    'The shell tool is available, so the sleep plus pty_read anti-pattern is reachable. ' +
    'The model has to block instead, and has to leave the finished session for the human.',
  prompt: () =>
    [
      'The file `gen.sh` in the current directory sleeps for a few seconds, prints one line,',
      'and exits.',
      '',
      'Start it in a background PTY session, wait until it has finished, then report the exact',
      'line it printed and its exit status. Do not report before it has finished.',
      '',
      'Then stop.',
    ].join('\n'),
  prepare: (context, token) => {
    program(context, 'gen.sh', [`sleep 6`, `printf 'FINISHED-${token}\\n'`, 'exit 0'].join('\n'))
  },
  answerMustContain: (token: string) => [`FINISHED-${token}`],
  answerMustNotContain: () => [],
  checks: (facts) => {
    const checks: CheckResult[] = []
    const slept = facts.shellCommands.filter((command) => /(^|[;&|]\s*)sleep\s+\d/.test(command))
    if (slept.length === 0) {
      checks.push(
        pass('no-sleep-polling', `${facts.shellCommands.length} shell command(s), none sleeping`)
      )
    } else {
      checks.push(fail('no-sleep-polling', `slept through the shell: ${slept.join(' | ')}`))
    }

    const reads = countCalls(facts.calls, 'pty_read')
    if (reads <= 2) {
      checks.push(pass('no-read-polling', `${reads} pty_read call(s)`))
    } else {
      checks.push(fail('no-read-polling', `${reads} pty_read calls is a polling loop`))
    }

    if (facts.discardedSessions.length === 0) {
      checks.push(pass('kept-the-session', 'no pty_kill with cleanup, the human keeps the log'))
    } else {
      checks.push(
        fail('kept-the-session', `${facts.discardedSessions.length} pty_kill with cleanup: true`)
      )
    }

    // The skill allows exactly two strategies for completion: block with
    // pty_wait, or ask for the <pty_exited> push. Anything else is the
    // anti-pattern this case exists to catch.
    const waits = countCalls(facts.calls, 'pty_wait')
    const askedForExitPush = facts.calls.some(
      (call) => call.name === 'pty_spawn' && /["']?notifyOnExit["']?\s*:\s*true/.test(call.args)
    )
    if (waits > 0 || askedForExitPush) {
      checks.push(
        pass(
          'waited-for-completion',
          `${waits} pty_wait call(s)${askedForExitPush ? ', notifyOnExit requested' : ''}`
        )
      )
    } else {
      checks.push(
        fail(
          'waited-for-completion',
          'neither pty_wait nor notifyOnExit: the model had no documented way to learn it finished'
        )
      )
    }
    return checks
  },
}

const smoke: Scenario = {
  id: 'smoke',
  title: 'A PTY session spawns and reads back',
  intent: 'The floor. If this fails every other assertion is about a plugin that never loaded.',
  prompt: () =>
    [
      'The file `gen.sh` in the current directory prints one line and keeps running.',
      '',
      'Start it in a background PTY session and report the exact line it printed.',
      '',
      'Then stop.',
    ].join('\n'),
  prepare: (context, token) => {
    program(context, 'gen.sh', [`printf 'SMOKE-${token}\\n'`, 'sleep 20'].join('\n'))
  },
  answerMustContain: (token: string) => [`SMOKE-${token}`],
  answerMustNotContain: () => [],
}

export const SCENARIOS: readonly Scenario[] = [smoke, truncation, screen, geometry, noPolling]

export function findScenario(id: string): Scenario | undefined {
  return SCENARIOS.find((scenario) => scenario.id === id)
}

/** Cases where the shell tool is deliberately left in the catalogue. */
const SHELL_ENABLED: ReadonlySet<string> = new Set(['no-polling'])

export function disabledToolsFor(scenario: Scenario): string[] {
  const disabled: string[] = [...ALWAYS_DISABLED]
  if (!SHELL_ENABLED.has(scenario.id)) disabled.push('shell', 'bash')
  return disabled
}

export function newToken(): string {
  return randomBytes(8).toString('hex')
}
