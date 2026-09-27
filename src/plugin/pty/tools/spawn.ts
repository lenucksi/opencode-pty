import { tool } from '@opencode-ai/plugin'
import { manager } from '../manager.ts'
import { checkCommandPermission, checkWorkdirPermission } from '../permissions.ts'
import { checkExecutable } from '../command-check.ts'
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
    cols: tool.schema
      .number()
      .optional()
      .describe(
        'Terminal width in columns. Defaults to the size the web UI last reported, or 240 when no client has ever connected. Set it when the program you are about to run cares about width (tables, wide output, TUIs).'
      ),
    rows: tool.schema
      .number()
      .optional()
      .describe('Terminal height in rows. Defaults like `cols`.'),
  },
  async execute(args, ctx) {
    await checkCommandPermission(args.command, args.args ?? [])

    if (args.workdir) {
      await checkWorkdirPermission(args.workdir)
    }

    // Before the spawn, while the command is still just a string. A relative
    // path to a file without the execute bit otherwise comes back as a live
    // session whose pty helper has already aborted, so the model gets a Bun
    // crash dump in the buffer and a session that claims to be running.
    const executable = checkExecutable(args.command, args.workdir, {
      ...process.env,
      ...args.env,
    })
    if (!executable.ok) {
      throw new Error(`PTY spawn failed: ${executable.reason}`)
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
        cols: args.cols,
        rows: args.rows,
      })
    )

    // The id and the geometry go on the tag as attributes, not only as prose
    // below it. Every other result tag in this tool family carries `id="..."`,
    // and a model that learned that convention from `pty_read`/`pty_screen`/
    // `pty_wait` looks for it here and - finding only `ID: ...` - concludes the
    // spawn returned no id at all. This is the one result a model must be able
    // to read mechanically, because the id is the input to every other call.
    const output = [
      `<pty_spawned id="${info.id}" cols="${info.cols}" rows="${info.rows}">`,
      `ID: ${info.id}`,
      `Title: ${info.title}`,
      `Command: ${info.command} ${info.args.join(' ')}`,
      `Workdir: ${info.workdir}`,
      `PID: ${info.pid}`,
      `Status: ${info.status}`,
      `NotifyOnExit: ${info.notifyOnExit}`,
      `TimeoutSeconds: ${info.timeoutSeconds ?? 'none'}`,
      // Reported so the model knows the geometry it got. A program that formats
      // for 80 columns and is given 40 wraps in the wrong places, and the output
      // itself never says why.
      `Size: ${info.cols}x${info.rows}`,
      `</pty_spawned>`,
      ...(info.notifyOnExit ? ['', NOTIFY_ON_EXIT_INSTRUCTIONS] : []),
    ].join('\n')

    return output
  },
})
