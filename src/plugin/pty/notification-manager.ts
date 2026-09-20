import type { SessionNotifier } from '../../adapters/types.ts'
import type { PTYSession } from './types.ts'
import type { OpencodeClient } from '@opencode-ai/sdk'
import {
  NOTIFICATION_LINE_TRUNCATE,
  NOTIFICATION_TAIL_LINES,
  NOTIFICATION_TITLE_TRUNCATE,
} from '../constants.ts'
import { logPtyEvent } from './plugin-log.ts'

export class NotificationManager implements SessionNotifier {
  private client: OpencodeClient | null = null

  init(client: OpencodeClient): void {
    this.client = client
  }

  async sendExitNotification(session: PTYSession, exitCode: number): Promise<void> {
    if (!this.client) {
      // A V2 host installs its own notifier; reaching this path means none was
      // wired, and returning silently here used to hide the lost notification
      // completely.
      logPtyEvent('warn', `no opencode client available for the exit notification of ${session.id}`)
      return
    }

    try {
      const message = buildExitNotification(session, exitCode)
      let modelContext: {
        model?: { providerID: string; modelID: string }
        variant?: string
      } = {}
      let currentAgent: string | undefined
      try {
        const parent = await this.client.session.get({
          path: { id: session.parentSessionId },
        })
        const info = parent.data as
          | (typeof parent.data & {
              agent?: string
              model?: { id: string; providerID: string; variant?: string }
            })
          | undefined
        currentAgent = info?.agent
        const model = info?.model
        if (model) {
          modelContext = {
            model: { providerID: model.providerID, modelID: model.id },
            ...(model.variant ? { variant: model.variant } : {}),
          }
        }
      } catch {
        // Older OpenCode versions may not expose the session agent or model.
      }
      // Prefer the parent session's current agent over the spawn-time snapshot
      // so an exit notification can't flip the session back to a stale agent.
      const agent = currentAgent ?? session.parentAgent
      await this.client.session.promptAsync({
        path: { id: session.parentSessionId },
        body: {
          parts: [{ type: 'text', text: message }],
          ...(agent ? { agent } : {}),
          ...modelContext,
        },
      })
    } catch (error) {
      // Surface delivery failures instead of swallowing them silently; the V2
      // notifier already warns, and a lost exit notification would otherwise be
      // invisible to the user.
      logPtyEvent('error', `failed to send exit notification for ${session.id}`, error)
    }
  }
}

/**
 * Builds the `<pty_exited>` notification text for a finished PTY session.
 *
 * Shared between the V1 notifier (`NotificationManager`, delivered via the
 * SDK client's `promptAsync`) and the V2 notifier (delivered via the plugin
 * context's `ctx.session.prompt`).
 */
export function buildExitNotification(session: PTYSession, exitCode: number): string {
  const lineCount = session.buffer.length
  const tail = collectTailLines(session, NOTIFICATION_TAIL_LINES)
  const lastLine = tail.at(-1) ?? ''

  const displayTitle = session.description ?? session.title
  const truncatedTitle =
    displayTitle.length > NOTIFICATION_TITLE_TRUNCATE
      ? `${displayTitle.slice(0, NOTIFICATION_TITLE_TRUNCATE)}...`
      : displayTitle

  const lines = [
    '<pty_exited>',
    `ID: ${session.id}`,
    `Description: ${truncatedTitle}`,
    `Exit Code: ${exitCode}`,
    `TimeoutSeconds: ${session.timeoutSeconds ?? 'none'}`,
    `Timed Out: ${session.timedOut ? 'yes' : 'no'}`,
    `Output Lines: ${lineCount}`,
    `Last Line: ${lastLine}`,
  ]

  if (tail.length > 1) {
    // The tail is what the model actually needs (ansible's `PLAY RECAP`, the
    // failing task, ...) and it arrives ANSI-free; previously only the last
    // line was sent, colour codes and all.
    lines.push('', `Tail (last ${tail.length} non-empty lines):`)
    for (const line of tail) {
      lines.push(`  ${line}`)
    }
  }

  lines.push('</pty_exited>', '')

  if (session.timedOut) {
    lines.push(
      'Process reached its PTY timeout and was stopped automatically. Use pty_read to inspect the final output.'
    )
  } else if (exitCode === 0) {
    lines.push('Use pty_read to check the full output.')
  } else {
    lines.push(
      'Process failed. Use pty_read with the pattern parameter to search for errors in the output.'
    )
  }

  return lines.join('\n')
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

/** The last `count` non-empty output lines, oldest first. */
function collectTailLines(session: PTYSession, count: number): string[] {
  const lines: string[] = []
  for (let i = session.buffer.length - 1; i >= 0 && lines.length < count; i--) {
    const line = session.buffer.read(i, 1)[0]
    if (line !== undefined && line.trim() !== '') {
      lines.unshift(truncateLine(line))
    }
  }
  return lines
}
