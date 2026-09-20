import type { Plugin } from '@opencode/plugin'
import type { SessionNotifier } from '../adapters/types.ts'
import { buildExitNotification } from '../plugin/pty/notification-manager.ts'
import { logPtyEvent, type PtyLogger } from '../plugin/pty/plugin-log.ts'
import type { PTYSession } from '../plugin/pty/types.ts'

/**
 * The subset of opencode v2's plugin `session` domain we use to wake a session.
 *
 * The full domain (`Plugin.Context["session"]`) also exposes `get`,
 * `switchModel`, `wait`, `context` and more; keeping the notifier bound to
 * `prompt` only makes it easy to construct in tests and resilient to hosts
 * that only expose part of the surface.
 */
export type V2SessionPrompt = Pick<Plugin.Context['session'], 'prompt'>

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null)?.then === 'function'
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value !== 'object') return typeof value
  return value.constructor?.name ?? 'object'
} /**
 * Delivers `<pty_exited>` notifications through opencode v2's plugin context.
 *
 * The notification is admitted as a user prompt with a deterministic message
 * id (`pty_<id>_exited`), so `admission.reconcile` makes repeated deliveries
 * idempotent (e.g. when a kill races the process exit). Default delivery
 * (`steer`) plus `execution.wake` starts a new agent turn, and opencode
 * resolves the run with the session's *current* model — so the user's model
 * selection is preserved without the explicit model lookup the V1 notifier
 * needs (`session/runner/model.ts` has no `agent.model` fallback like the
 * V1 `setAgentModel` chain did).
 *
 * Every outcome is logged (see `plugin-log.ts`): a wake-up that never arrives
 * must not be indistinguishable from "the model decided not to respond". A
 * host that returns a lazy (Effect-style) value instead of a promise is
 * reported as a delivery failure rather than silently awaited away.
 */
export class V2SessionNotifier implements SessionNotifier {
  constructor(
    private readonly session: V2SessionPrompt,
    private readonly log: PtyLogger = logPtyEvent
  ) {}

  async sendExitNotification(session: PTYSession, exitCode: number): Promise<void> {
    if (!session.parentSessionId) {
      this.log('warn', `cannot notify: session ${session.id} has no parent session`)
      return
    }

    const messageId = `pty_${session.id}_exited`
    const text = buildExitNotification(session, exitCode)

    try {
      const result: unknown = this.session.prompt({
        sessionID: session.parentSessionId,
        id: messageId,
        text,
      })

      if (!isPromiseLike(result)) {
        this.log(
          'error',
          `exit notification for ${session.id} was not delivered: prompt() returned a non-promise value`,
          { returned: describe(result), sessionID: session.parentSessionId }
        )
        return
      }

      await result
      this.log('info', `exit notification delivered for ${session.id}`, {
        sessionID: session.parentSessionId,
        messageID: messageId,
      })
    } catch (error) {
      this.log('error', `failed to deliver exit notification for ${session.id}`, error)
    }
  }
}
