import { tool } from '@opencode-ai/plugin'
import { manager } from '../manager.ts'
import { checkCommandPermission, checkWorkdirPermission } from '../permissions.ts'
import { describeError } from '../utils.ts'
import DESCRIPTION from './spawn.txt'

/**
 * Run the spawn and, when it fails, report the cause.
 *
 * The previous bare failure left the model guessing (it invented a "session
 * limit" after a script that was not executable). The reason plus the usual
 * fixes is more useful than the exception alone.
 */
function spawnOrExplain<R>(command: string, run: () => R): R {
  try {
    return run()
  } catch (error) {
    throw new Error(
      `PTY spawn failed for '${command}': ${describeError(error)}. ` +
        'Check that the command exists and is executable, and start scripts through their interpreter (e.g. `bash /path/script.sh`).'
    )
  }
}

const NOTIFY_ON_EXIT_INSTRUCTIONS = [
  `<system_reminder>`,
  `Completion signal for this session is the future \`<pty_exited>\` message.`,
  `If you only need to know whether the command finished, do not call \`pty_read\`; wait for \`<pty_exited>\`.`,
  `Never use sleep plus \`pty_read\` loops to check completion for this session.`,
  `Call \`pty_read\` before exit only if you need live output now, the user explicitly asks for logs, or the exit notification reports a non-zero status and you need to investigate.`,
  `If no \`<pty_exited>\` arrives (exit notifications are unavailable on some hosts), do not wait indefinitely: call \`pty_wait\` to block until the session exits.`,
  `</system_reminder>`,
].join('\n')

export const ptySpawn = tool({
  description: DESCRIPTION,
  args: {
    command: tool.schema.string().describe('The command/executable to run'),
    args: tool.schema.array(tool.schema.string()).describe('Arguments to pass to the command'),
    workdir: tool.schema.string().optional().describe('Working directory for the PTY session'),
    env: tool.schema
      .record(tool.schema.string(), tool.schema.string())
      .optional()
      .describe('Additional environment variables'),
    title: tool.schema.string().optional().describe('Human-readable title for the session'),
    description: tool.schema
      .string()
      .describe('Clear, concise description of what this PTY session is for in 5-10 words'),
    notifyOnExit: tool.schema
      .boolean()
      .optional()
      .describe(
        'If true, sends a notification to the session when the process exits (default: false)'
      ),
    timeoutSeconds: tool.schema
      .number()
      .optional()
      .describe(
        'Optional per-session timeout in seconds. The PTY is killed automatically when this duration elapses.'
      ),
  },
  async execute(args, ctx) {
    await checkCommandPermission(args.command, args.args ?? [])

    if (args.workdir) {
      await checkWorkdirPermission(args.workdir)
    }

    const sessionId = ctx.sessionID
    const rendered = [args.command, ...(args.args ?? [])].join(' ')
    const info = spawnOrExplain(rendered, () =>
      manager.spawn({
        command: args.command,
        args: args.args,
        workdir: args.workdir,
        env: args.env,
        title: args.title,
        description: args.description,
        parentSessionId: sessionId,
        parentAgent: ctx.agent,
        notifyOnExit: args.notifyOnExit,
        timeoutSeconds: args.timeoutSeconds,
      })
    )

    const output = [
      `<pty_spawned>`,
      `ID: ${info.id}`,
      `Title: ${info.title}`,
      `Command: ${info.command} ${info.args.join(' ')}`,
      `Workdir: ${info.workdir}`,
      `PID: ${info.pid}`,
      `Status: ${info.status}`,
      `NotifyOnExit: ${info.notifyOnExit}`,
      `TimeoutSeconds: ${info.timeoutSeconds ?? 'none'}`,
      `</pty_spawned>`,
      ...(info.notifyOnExit ? ['', NOTIFY_ON_EXIT_INSTRUCTIONS] : []),
    ].join('\n')

    return output
  },
})
