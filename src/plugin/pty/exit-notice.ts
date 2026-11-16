/**
 * What an exit notification needs, and nothing else.
 *
 * The daemon used to push the whole live `PTYSession` as JSON. A `RingBuffer` keeps its
 * state in private fields and its `length` and `read()` on the prototype, so JSON carried
 * the bytes and dropped the behaviour: the tag said `Output Lines: undefined` and the tail
 * was empty exactly when it mattered - on a daemon-managed session, which is the normal
 * case here.
 *
 * The fix is on the sending side: compute the few fields the notice needs **where the real
 * buffer lives**, and put those on the wire. The client then renders plain data. Nothing
 * here replaces the buffer: `pty_read`, `pty_screen`, downloads and the archive still ask
 * the daemon, which answers from the full buffer it owns.
 *
 * `exitNoticeFromWire` also accepts the old shape. A daemon outlives the host that started
 * it, so a new plugin can briefly meet an old daemon; that window degrades to a working
 * notice instead of a broken one.
 */

import { encodeMessage } from '../../daemon/protocol.ts'
import {
  NOTIFICATION_LINE_TRUNCATE,
  NOTIFICATION_TAIL_LINES,
  NOTIFICATION_TITLE_TRUNCATE,
} from '../constants.ts'
import type { PTYSession } from './types.ts'

/** The plain, validated payload of an `exit_notification` push. */
export interface ExitNoticeData {
  id: string
  parentSessionId?: string
  parentAgent?: string
  description: string
  exitCode: number
  timeoutSeconds?: number
  timedOut: boolean
  lineCount: number
  /** The last non-empty lines, ANSI-free and length-capped, oldest first. */
  tail: string[]
}

/** `Bun.stripANSI` when available; raw text otherwise (never throw). */
function stripAnsi(text: string): string {
  return typeof Bun !== 'undefined' && typeof Bun.stripANSI === 'function'
    ? Bun.stripANSI(text)
    : text
}

/** One notification line: ANSI-free, right-trimmed and length-capped. */
function truncateLine(line: string): string {
  const clean = stripAnsi(line).replace(/\s+$/, '')
  return clean.length > NOTIFICATION_LINE_TRUNCATE
    ? `${clean.slice(0, NOTIFICATION_LINE_TRUNCATE)}...`
    : clean
}

/** The same line split `RingBuffer` uses: a trailing newline is not an empty line. */
function splitLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** The last `count` non-empty lines, oldest first. */
function tailFromLines(lines: string[], count: number): string[] {
  const tail: string[] = []
  for (let i = lines.length - 1; i >= 0 && tail.length < count; i -= 1) {
    const line = lines[i]
    if (line !== undefined && line.trim() !== '') tail.unshift(truncateLine(line))
  }
  return tail
}

/** Build the notice from a live session, while its buffer is still a `RingBuffer`. */
export function exitNoticeData(session: PTYSession, exitCode: number): ExitNoticeData {
  const lines = session.buffer.read()
  return {
    id: session.id,
    ...(session.parentSessionId === undefined ? {} : { parentSessionId: session.parentSessionId }),
    ...(session.parentAgent === undefined ? {} : { parentAgent: session.parentAgent }),
    description: session.description ?? session.title,
    exitCode,
    ...(session.timeoutSeconds === undefined ? {} : { timeoutSeconds: session.timeoutSeconds }),
    timedOut: session.timedOut,
    lineCount: session.buffer.length,
    tail: tailFromLines(lines, NOTIFICATION_TAIL_LINES),
  }
}

/** The wire message the daemon pushes when a session exits. */
export function encodeExitNotice(data: ExitNoticeData): string {
  return encodeMessage({ method: 'exit_notification', params: { ...data } })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** The new wire shape, validated rather than trusted across a process boundary. */
function fromNewShape(params: Record<string, unknown>): ExitNoticeData | null {
  if (typeof params.id !== 'string' || params.id === '') return null
  if (!Array.isArray(params.tail) || !params.tail.every((line) => typeof line === 'string')) {
    return null
  }
  return {
    id: params.id,
    ...(typeof params.parentSessionId === 'string'
      ? { parentSessionId: params.parentSessionId }
      : {}),
    ...(typeof params.parentAgent === 'string' ? { parentAgent: params.parentAgent } : {}),
    description: text(params.description),
    exitCode: numberOr(params.exitCode, 1),
    ...(typeof params.timeoutSeconds === 'number' ? { timeoutSeconds: params.timeoutSeconds } : {}),
    timedOut: params.timedOut === true,
    lineCount: numberOr(params.lineCount, 0),
    tail: params.tail as string[],
  }
}

/** The old shape: a JSON-serialised session whose buffer lost its prototype. */
function fromOldShape(params: Record<string, unknown>, exitCode: number): ExitNoticeData | null {
  const session = params.session
  if (!isRecord(session) || typeof session.id !== 'string' || session.id === '') return null
  const buffer = session.buffer
  const retained = isRecord(buffer) && typeof buffer.buffer === 'string' ? buffer.buffer : ''
  const lines = splitLines(retained)
  return {
    id: session.id,
    ...(typeof session.parentSessionId === 'string'
      ? { parentSessionId: session.parentSessionId }
      : {}),
    ...(typeof session.parentAgent === 'string' ? { parentAgent: session.parentAgent } : {}),
    description: text(session.description ?? session.title),
    exitCode,
    ...(typeof session.timeoutSeconds === 'number'
      ? { timeoutSeconds: session.timeoutSeconds }
      : {}),
    timedOut: session.timedOut === true,
    lineCount: lines.length,
    tail: tailFromLines(lines, NOTIFICATION_TAIL_LINES),
  }
}

/** Accept both shapes; return null for a message that cannot be rendered at all. */
export function exitNoticeFromWire(params: Record<string, unknown>): ExitNoticeData | null {
  const newer = fromNewShape(params)
  if (newer !== null) return newer
  return fromOldShape(params, numberOr(params.exitCode, 1))
}

/** Render the tag. Takes data, not a session: no prototype can go missing here. */
export function buildExitNotice(data: ExitNoticeData): string {
  const truncatedTitle =
    data.description.length > NOTIFICATION_TITLE_TRUNCATE
      ? `${data.description.slice(0, NOTIFICATION_TITLE_TRUNCATE)}...`
      : data.description
  const lastLine = data.tail.at(-1) ?? ''

  const lines = [
    `<pty_exited id="${data.id}">`,
    `ID: ${data.id}`,
    `Description: ${truncatedTitle}`,
    `Exit Code: ${data.exitCode}`,
    `TimeoutSeconds: ${data.timeoutSeconds ?? 'none'}`,
    `Timed Out: ${data.timedOut ? 'yes' : 'no'}`,
    `Output Lines: ${data.lineCount}`,
    `Last Line: ${lastLine}`,
  ]

  if (data.tail.length > 1) {
    lines.push('', `Tail (last ${data.tail.length} non-empty lines):`)
    for (const line of data.tail) lines.push(`  ${line}`)
  }

  lines.push('</pty_exited>', '')

  if (data.timedOut) {
    lines.push(
      'Process reached its PTY timeout and was stopped automatically. Use pty_read to inspect the final output.'
    )
  } else if (data.exitCode === 0) {
    lines.push('Use pty_read to check the full output.')
  } else {
    lines.push(
      'Process failed. Use pty_read with the pattern parameter to search for errors in the output.'
    )
  }

  return lines.join('\n')
}

/** For the in-process caller that still holds a live session. */
export function buildExitNotification(session: PTYSession, exitCode: number): string {
  return buildExitNotice(exitNoticeData(session, exitCode))
}
