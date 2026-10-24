import { tool } from '@opencode-ai/plugin'

import { keySequence, knownKeyNames, MAX_KEY_TIMES } from '../keys.ts'
import { getPtyManager } from '../manager.ts'
import { buildSessionNotFoundError } from '../utils.ts'
import DESCRIPTION from './sendkey.txt'

/**
 * Send named keys to a session.
 *
 * The same underlying write as `pty_write`, which is why it takes the same gate:
 * keystrokes into a running program are what `pty_write` already does, and a key
 * name is only a more legible spelling of the bytes. A whole command still has to be
 * typed through `pty_write`, where the permission policy sees it.
 */
export const ptySendkey = tool({
  description: DESCRIPTION,
  args: {
    id: tool.schema.string().describe('The PTY session ID (e.g., pty_a1b2c3d4)'),
    key: tool.schema
      .string()
      .describe('The key by name: Enter, Tab, Escape, Up, C-c, F5, ... (see the tool text)'),
    times: tool.schema
      .number()
      .int()
      .min(1)
      .max(MAX_KEY_TIMES)
      .optional()
      .describe(`How often to send it (default 1, at most ${MAX_KEY_TIMES})`),
  },
  async execute(args) {
    const session = await getPtyManager().get(args.id)
    if (!session) {
      throw await buildSessionNotFoundError(args.id)
    }
    if (session.status !== 'running') {
      throw new Error(`Cannot send keys to PTY '${args.id}' - status is '${session.status}'.`)
    }

    const sequence = keySequence(args.key)
    if (sequence === null) {
      throw new Error(
        `Unknown key '${args.key}'. Known names include ${knownKeyNames().join(', ')}. ` +
          'For anything else, send the bytes with pty_write.'
      )
    }

    const times = args.times ?? 1
    const success = await getPtyManager().write(args.id, sequence.repeat(times))
    if (!success) {
      throw new Error(`Failed to send '${args.key}' to PTY '${args.id}'.`)
    }

    const bytes = sequence.length * times
    const count = `${times} ${times === 1 ? 'time' : 'times'}`
    return `Sent ${args.key} ${count} to ${args.id} (${bytes} byte${bytes === 1 ? '' : 's'}).`
  },
})
