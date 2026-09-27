/**
 * Reduce a transcript to the handful of facts a scenario can assert on.
 *
 * Keeping this in one place means every case is judged from the same evidence:
 * which `pty_*` calls were made, what the tool handed back, and what the model
 * finally said.
 */

import { finalAnswer, type Transcript } from './events.ts'
import {
  collectOfferedCursors,
  collectPtyCalls,
  collectShellCommands,
  isPtyToolName,
  readBooleanField,
  readNumberField,
  readStringField,
  sawEndOfBufferClaim,
  sawTruncationMarker,
  type ToolCallRecord,
} from './pty-calls.ts'

export type CheckStatus = 'pass' | 'fail' | 'skip'

/** One named assertion, with the evidence that decided it. */
export interface CheckResult {
  name: string
  status: CheckStatus
  detail: string
  /**
   * Measured, not gated.
   *
   * An advisory check is reported but never changes the verdict, so a case is
   * not demoted for a behaviour the tool deliberately allows. A non-advisory
   * `skip` still means "the case never got to test this", which is not a pass.
   */
  advisory?: boolean
}

export interface RunFacts {
  answer: string
  calls: ToolCallRecord[]
  /** Every character any tool handed back to the model. */
  toolOutput: string
  /** Only what a `pty_*` tool handed back, so "did it read the output" is askable. */
  ptyToolOutput: string
  /** `nextSince` values the model was actually shown. */
  offeredCursors: number[]
  /** A `pty_read` that resumed with a cursor the model had been offered. */
  resumedWithOfferedCursor: boolean
  /** Every `since` value the model passed, offered or not. */
  usedSinceValues: number[]
  /** Some result the model received was cut by the budget. */
  sawCut: boolean
  /** Some result the model received claimed to be the end of the data. */
  sawEndOfBufferClaim: boolean
  /**
   * A result claimed to be the end of the data *and* said it was cut.
   *
   * That contradiction is the bug the read budget replaced, and it is
   * observable from a run: the model receives the text, so if the text ever
   * says both, a model is entitled to believe it is finished.
   */
  contradictoryResult: boolean
  /** At least one `pty_read` came after the first result that was cut. */
  readAfterFirstCut: boolean
  /** How many `pty_read` calls followed the first cut. */
  readsAfterFirstCut: number
  /** A `pty_read` that raised its own budget instead of paging. */
  raisedReadBudget: boolean
  /** A `pty_read` with `all: true`. */
  readUnbounded: boolean
  /** A `pty_read` narrowed with a regex. */
  readWithPattern: boolean
  shellCommands: string[]
  /** `pty_spawn` results, verbatim. */
  spawnOutputs: string[]
  /** `pty_resize` / spawn `cols` / spawn `rows`, when the model used them. */
  geometryTouched: boolean
  /** `pty_kill` calls that would have thrown the session away. */
  discardedSessions: number[]
  timedOut: boolean
  errors: string[]
  pluginLoaded: boolean
}

export function callNames(calls: readonly ToolCallRecord[]): string[] {
  return calls.map((call) => call.name)
}

export function countCalls(calls: readonly ToolCallRecord[], name: string): number {
  return calls.filter((call) => call.name === name).length
}

/**
 * Did any single result claim to be the end of the data and, in the same breath,
 * say it was cut?
 *
 * Scanned per `<pty_output>` block rather than per tool output: one `execute`
 * call can return several results at once, and a cut result next to a finished
 * one is not a contradiction.
 */
export function contradictoryBlocks(output: string): boolean {
  return output
    .split('<pty_output')
    .slice(1)
    .some((block) => {
      const self = `<pty_output${block.split('</pty_output>')[0] ?? block}`
      return sawTruncationMarker(self) && sawEndOfBufferClaim(self)
    })
}

/** Did this host-level tool call make at least one `pty_read`? */
function isRead(call: { tool: string; input: string }): boolean {
  return call.tool === 'pty_read' || /tools\s*(?:\.\s*)?pty_read\s*\(/.test(call.input)
}

/** `Size: <cols>x<rows>` as the spawn result reported it, when the model saw one. */
export function reportedGeometry(
  outputs: readonly string[]
): { cols: number; rows: number } | null {
  for (const output of outputs) {
    const match = /Size:\s*(\d+)x(\d+)/.exec(output)
    if (match && match[1] !== undefined && match[2] !== undefined) {
      return { cols: Number(match[1]), rows: Number(match[2]) }
    }
  }
  return null
}

export function buildFacts(
  transcript: Transcript,
  options: { pluginLoaded: boolean; timedOut: boolean }
): RunFacts {
  const calls = collectPtyCalls(transcript.toolCalls)
  const toolOutput = transcript.toolCalls.map((call) => call.output).join('\n')
  // A case that leaves the shell tool in reach can be answered from the *source*
  // of the fixture rather than from its output, so the two are kept apart.
  const ptyToolOutput = transcript.toolCalls
    .filter((call) => isPtyToolName(call.tool) || /tools\s*(?:\.\s*)?pty_/.test(call.input))
    .map((call) => call.output)
    .join('\n')
  const reads = calls.filter((call) => call.name === 'pty_read')
  const usedSinceValues: number[] = []
  let resumedWithOfferedCursor = false
  const offeredCursors = collectOfferedCursors(toolOutput)
  const offered = new Set(offeredCursors)

  for (const read of reads) {
    const since = readNumberField(read.args, 'since')
    if (since !== null) {
      usedSinceValues.push(since)
      if (offered.has(since)) resumedWithOfferedCursor = true
    }
  }

  const discarded: number[] = []
  let geometryTouched = false

  // One `execute` call can make several `pty_read` calls at once, so "what did
  // the model see first" is a property of the outputs, not of the call
  // boundaries: the cut that matters is the first one it had in front of it.
  const firstCut = transcript.toolCalls.findIndex((call) => sawTruncationMarker(call.output))
  const readsAfterFirstCut =
    firstCut === -1
      ? 0
      : transcript.toolCalls.slice(firstCut + 1).filter((call) => isRead(call)).length
  for (const call of calls) {
    if (call.name === 'pty_kill' && readBooleanField(call.args, 'cleanup') === true) {
      discarded.push(1)
    }
    if (call.name === 'pty_resize') geometryTouched = true
    if (
      call.name === 'pty_spawn' &&
      (readNumberField(call.args, 'cols') !== null || readNumberField(call.args, 'rows') !== null)
    ) {
      geometryTouched = true
    }
  }

  const spawnOutputs = calls
    .filter((call) => call.name === 'pty_spawn')
    .map((call) => call.output)
    .filter((output) => output.includes('<pty_spawned>'))

  return {
    answer: finalAnswer(transcript),
    calls,
    ptyToolOutput,
    contradictoryResult: transcript.toolCalls.some((call) => contradictoryBlocks(call.output)),
    readAfterFirstCut: readsAfterFirstCut > 0,
    readsAfterFirstCut,
    toolOutput,
    offeredCursors,
    resumedWithOfferedCursor,
    usedSinceValues,
    sawCut: sawTruncationMarker(toolOutput),
    sawEndOfBufferClaim: sawEndOfBufferClaim(toolOutput),
    raisedReadBudget: reads.some((read) => {
      const maxTokens = readNumberField(read.args, 'maxTokens')
      return maxTokens !== null && maxTokens > 1500
    }),
    readUnbounded: reads.some((read) => readBooleanField(read.args, 'all') === true),
    readWithPattern: reads.some((read) => readStringField(read.args, 'pattern') !== null),
    shellCommands: collectShellCommands(transcript.toolCalls),
    spawnOutputs,
    geometryTouched,
    discardedSessions: discarded,
    timedOut: options.timedOut,
    errors: transcript.errors.map((error) => `${error.type}: ${error.message}`),
    pluginLoaded: options.pluginLoaded,
  }
}
