import { tool } from '@opencode-ai/plugin'
import { checkExecutable } from '../command-check.ts'
import { getPtyManager } from '../manager.ts'
import { checkCommandPermission, checkWorkdirPermission } from '../permissions.ts'
import { describeError } from '../utils.ts'
import { getToolRoute, type ToolRoute } from './description.ts'
import DESCRIPTION from './spawn.txt'

/**
 * Run the spawn and, when it fails, report the cause.
 *
 * The previous bare failure left the model guessing (it invented a "session
 * limit" after a script that was not executable). The reason plus the usual
 * fixes is more useful than the exception alone.
 */
async function spawnOrExplain<R>(command: string, run: () => Promise<R>): Promise<R> {
  try {
    return run()
  } catch (error) {
    throw new Error(
      `PTY spawn failed for '${command}': ${describeError(error)}. ` +
        'Check that the command exists and is executable, and start scripts through their interpreter (e.g. `bash /path/script.sh`).'
    )
  }
}

/**
 * What the route says about the exit, when the session asked to be told.
 *
 * The OpenCode route has a conversation to deliver the message into, so the
 * message is the signal. The MCP route has none, so the wait is - and the text
 * says so, because a model that was told to expect a message and gets none waits
 * for nothing.
 */
const NOTIFY_ON_EXIT_INSTRUCTIONS: Record<ToolRoute, string> = {
  opencode: [
    `<system_reminder>`,
    `Completion signal for this session is the future \`<pty_exited>\` message.`,
    `If you only need to know whether the command finished, do not call \`pty_read\`; wait for \`<pty_exited>\`.`,
    `Never use sleep plus \`pty_read\` loops to check completion for this session.`,
    `Call \`pty_read\` before exit only if you need live output now, the user explicitly asks for logs, or the exit notification reports a non-zero status and you need to investigate.`,
    `If no \`<pty_exited>\` arrives (exit notifications are unavailable on some hosts), do not wait indefinitely: call \`pty_wait\` to block until the session exits.`,
    `</system_reminder>`,
  ].join('\n'),
  mcp: [
    `<system_reminder>`,
    `\`notifyOnExit\` has NO effect on this route: the exit is not delivered as a message, because there is no conversation to deliver it into.`,
    `Completion signal for this session is \`pty_wait\`: call it with the id and it answers when the session ends, or it answers with a timeout and you call it again.`,
    `Never use sleep plus \`pty_read\` loops to check completion for this session.`,
    `Call \`pty_read\` before exit only if you need live output now, the user explicitly asks for logs, or the wait reports a non-zero status and you need to investigate.`,
    `</system_reminder>`,
  ].join('\n'),
}

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
    raw: tool.schema
      .boolean()
      .optional()
      .describe(
        'Run with the PTY line discipline disabled (stty raw -echo). Use for a serial console (e.g. `virsh console`) or any program that wants a `\\r` to stay a `\\r`: cooked mode turns Enter into `\\n` and the program ignores it. Not for shells - it disables echo and line editing. Defaults to false.'
      ),
  },
  async execute(args, ctx) {
    // The host knows its permission rules per session, so the question carries the
    // session it is about: the tool context is where that comes from.
    const subject = { sessionID: ctx.sessionID, agent: ctx.agent }
    await checkCommandPermission(args.command, args.args ?? [], subject)

    if (args.workdir) {
      await checkWorkdirPermission(args.workdir, subject)
    }

    // `args.env` is documented - in the schema, to the model - as ADDITIONAL
    // variables, so it goes to the lifecycle layer exactly as it arrived. That
    // layer merges it over the parent's environment, which is where the merge
    // lives: it is the only place that knows a session can also be started from
    // the web UI or the SDK, and duplicating the merge here was how the check
    // and the spawn ended up disagreeing about the environment a command runs
    // in. See `spawnProcess` in `session-lifecycle.ts` for why the merge is not
    // optional.
    //
    // The executable check still needs the full environment, because it looks up
    // the command in PATH.
    //
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
    const info = await spawnOrExplain(
      rendered,
      async () =>
        await getPtyManager().spawn({
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
          raw: args.raw,
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
      `Raw: ${info.raw === true}`,
      `</pty_spawned>`,
      ...(info.notifyOnExit ? ['', NOTIFY_ON_EXIT_INSTRUCTIONS[getToolRoute()]] : []),
    ].join('\n')

    return output
  },
})
