import { tool } from '@opencode-ai/plugin'
import { charsForTokens, DEFAULT_READ_MAX_TOKENS } from '../../../shared/constants.ts'
import { formatLine, TRUNCATION_MARKER } from '../formatters.ts'
import { manager } from '../manager.ts'
import {
  registerSessionUpdateCallback,
  removeSessionUpdateCallback,
} from '../manager-notifications.ts'
import type { PTYSessionInfo } from '../types.ts'
import { buildSessionNotFoundError } from '../utils.ts'
import DESCRIPTION from './wait.txt'

const WAIT_TAIL_LINES = 20
const TIMEOUT = Symbol('pty_wait_timeout')

function isTerminal(session: PTYSessionInfo): boolean {
  return session.status === 'exited' || session.status === 'killed'
}

/**
 * Reads the tail of a session's buffer as numbered lines, within the read budget.
 *
 * Shares `applyLineBudget` with `pty_read`, so a line the budget cuts is marked
 * the same way here as it is there, and the block says how much of the buffer the
 * tail accounts for.
 */
async function formatTail(
  session: PTYSessionInfo,
  count: number,
  budget: number
): Promise<TailLines> {
  const offset = Math.max(0, session.lineCount - count)
  const result = await manager.read(session.id, offset, count, budget)
  if (!result || result.lines.length === 0) {
    return { lines: [], truncatedLines: 0, shownChars: 0, bufferChars: session.charCount }
  }
  return {
    lines: result.slices.map((slice, index) => {
      const formatted = formatLine(slice.text, result.offset + index + 1, slice.shownChars)
      return slice.truncated
        ? `${formatted.text}${TRUNCATION_MARKER(slice.shownChars, slice.totalChars)}`
        : formatted.text
    }),
    truncatedLines: result.truncatedLines,
    shownChars: result.shownChars,
    bufferChars: result.bufferChars,
  }
}

interface TailLines {
  lines: string[]
  truncatedLines: number
  shownChars: number
  bufferChars: number
}

async function formatWaitedBlock(session: PTYSessionInfo, budget: number): Promise<string> {
  const tail = await formatTail(session, WAIT_TAIL_LINES, budget)
  const exitInfo = `${session.exitCode ?? 'unknown'}${session.exitSignal ? `, signal: ${session.exitSignal}` : ''}`
  const attrs = [
    `id="${session.id}"`,
    `status="${session.status}"`,
    `lines="${session.lineCount}"`,
    `chars="${session.charCount}"`,
  ]
  if (tail.truncatedLines) attrs.push(`truncated="true"`)
  return [
    `<pty_waited ${attrs.join(' ')}>`,
    `ID: ${session.id}`,
    `Title: ${session.title}`,
    `Command: ${session.command} ${session.args.join(' ')}`,
    `Status: ${session.status}`,
    `Exit: ${exitInfo}`,
    `Output Lines: ${session.lineCount} | Chars: ${session.charCount}`,
    ...(tail.lines.length > 0 ? ['', 'Tail:', ...tail.lines] : []),
    ...(tail.truncatedLines
      ? [
          '',
          `(Tail cut by the ${DEFAULT_READ_MAX_TOKENS} token budget: ${tail.shownChars} of ${tail.bufferChars} chars shown. Use pty_read for the rest.)`,
        ]
      : []),
    `</pty_waited>`,
  ].join('\n')
}

export const ptyWait = tool({
  description: DESCRIPTION,
  args: {
    id: tool.schema.string().describe('The PTY session ID (e.g., pty_a1b2c3d4)'),
    timeoutSeconds: tool.schema
      .number()
      .optional()
      .describe(
        'Maximum time to wait in seconds. If the session is still running after this, returns a <pty_wait_timeout> result instead of blocking forever. Default: no limit.'
      ),
  },
  async execute(args) {
    const tailBudget = charsForTokens(DEFAULT_READ_MAX_TOKENS)
    const _g1 = manager.get(args.id)
    const initial = _g1 instanceof Promise ? await _g1 : _g1
    if (!initial) {
      throw await buildSessionNotFoundError(args.id)
    }
    if (isTerminal(initial)) {
      return await formatWaitedBlock(initial, tailBudget)
    }

    let resolveDone!: (session: PTYSessionInfo) => void
    const done = new Promise<PTYSessionInfo>((resolve) => {
      resolveDone = resolve
    })

    const onUpdate = (updated: PTYSessionInfo): void => {
      if (updated.id !== args.id || !isTerminal(updated)) {
        return
      }
      removeSessionUpdateCallback(onUpdate)
      resolveDone(updated)
    }
    registerSessionUpdateCallback(onUpdate)

    // Close the race window between the initial get and registration.
    const _g2 = manager.get(args.id)
    const recheck = _g2 instanceof Promise ? await _g2 : _g2
    if (!recheck) {
      removeSessionUpdateCallback(onUpdate)
      throw await buildSessionNotFoundError(args.id)
    }
    if (isTerminal(recheck)) {
      removeSessionUpdateCallback(onUpdate)
      resolveDone(recheck)
    }

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    const timeoutSeconds = args.timeoutSeconds
    let timeout: Promise<typeof TIMEOUT>
    if (timeoutSeconds === undefined) {
      timeout = new Promise<typeof TIMEOUT>(() => {})
    } else {
      timeout = new Promise<typeof TIMEOUT>((resolve) => {
        timeoutHandle = setTimeout(
          () => {
            removeSessionUpdateCallback(onUpdate)
            resolve(TIMEOUT)
          },
          Math.max(0, Math.floor(timeoutSeconds * 1000))
        )
      })
    }

    const winner = await Promise.race([done, timeout])
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle)
    }
    if (winner === TIMEOUT) {
      return [
        `<pty_wait_timeout id="${args.id}">`,
        `Session is still running after ${Math.max(0, args.timeoutSeconds ?? 0)}s.`,
        `Use pty_read for live output, pty_kill to stop it, or call pty_wait again with a longer timeout.`,
        `</pty_wait_timeout>`,
      ].join('\n')
    }
    return await formatWaitedBlock(winner, tailBudget)
  },
})
