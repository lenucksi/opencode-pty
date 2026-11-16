import type { OpencodeClient } from '@opencode-ai/sdk'
import type { SessionNoticeTarget, SessionNotifier } from '../../adapters/types.ts'
import { buildExitNotice, exitNoticeData, type ExitNoticeData } from './exit-notice.ts'
import { logPtyEvent } from './plugin-log.ts'
import type { PTYSession } from './types.ts'

/** Kept for the in-process callers and tests that still hold a live session. */
export { buildExitNotification } from './exit-notice.ts'
export type { ExitNoticeData } from './exit-notice.ts'

export class NotificationManager implements SessionNotifier {
  private client: OpencodeClient | null = null

  init(client: OpencodeClient): void {
    this.client = client
  }

  /**
   * Compatibility for an in-process caller: derive the plain data while the session is
   * still live, then take the same path the daemon push takes.
   */
  async sendExitNotification(session: PTYSession, exitCode: number): Promise<void> {
    await this.sendExitNotice(exitNoticeData(session, exitCode))
  }

  async sendExitNotice(data: ExitNoticeData): Promise<void> {
    if (!data.parentSessionId) {
      // Nobody to wake: a session created without a conversation has no target.
      logPtyEvent('warn', `no parent session to notify for ${data.id}`)
      return
    }
    await this.sendNotice(
      {
        id: data.id,
        parentSessionId: data.parentSessionId,
        ...(data.parentAgent ? { parentAgent: data.parentAgent } : {}),
      },
      buildExitNotice(data),
      'exited'
    )
  }

  /**
   * Wake a session with arbitrary text (exit, restart, ...).
   *
   * The parent session's current agent/model is looked up so a notice cannot
   * flip the session back to a stale agent.
   */
  async sendNotice(target: SessionNoticeTarget, text: string, kind: string): Promise<void> {
    if (!this.client) {
      // A V2 host installs its own notifier; reaching this path means none was
      // wired, and returning silently here used to hide the lost notification
      // completely.
      logPtyEvent(
        'warn',
        `no opencode client available for the ${kind} notification of ${target.id}`
      )
      return
    }

    try {
      let modelContext: {
        model?: { providerID: string; modelID: string }
        variant?: string
      } = {}
      let currentAgent: string | undefined
      try {
        const parent = await this.client.session.get({
          path: { id: target.parentSessionId },
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

      const agent = currentAgent ?? target.parentAgent
      await this.client.session.promptAsync({
        path: { id: target.parentSessionId },
        body: {
          parts: [{ type: 'text', text }],
          ...(agent ? { agent } : {}),
          ...modelContext,
        },
      })
    } catch (error) {
      // Surface delivery failures instead of swallowing them silently; a lost
      // notification would otherwise be invisible to the user.
      logPtyEvent('error', `failed to send ${kind} notification for ${target.id}`, error)
    }
  }
}
