import { logPtyEvent, type PtyLogger } from '../plugin/pty/plugin-log.ts'
import type { SkillDraft, SkillInfoV2 } from './types.ts'

/**
 * Embedded skill shipped with the plugin.
 *
 * Skills load on demand (the model pulls them in when relevant), so the
 * detailed usage guidance lives here instead of in the always-on tool
 * descriptions, which stay terse on purpose to avoid burning tokens in every
 * session.
 */
export const PTY_USAGE_SKILL: SkillInfoV2 = {
  name: 'pty-usage',
  description:
    'Use when a command needs a TTY: interactive prompts, long-running or background processes, TUIs (vim/htop), watching live output, or when the exit status matters. Covers pty_spawn/pty_write/pty_read/pty_wait/pty_list/pty_kill.',
  slash: false,
  location: 'opencode-pty:pty-usage',
  content: `# Using the pty_* tools

The \`pty_*\` tools run real PTY sessions. Use them whenever a process needs a
terminal instead of a one-shot command.

## When to use pty_* instead of bash

Use \`pty_spawn\` when **any** of these is true:

- The process keeps running (dev server, file watcher, local API, REPL, daemon).
- The process may ask for input (password, confirmation, a TUI keystroke).
- You need live output while it runs, not just the final result.
- You will run several things concurrently and want them managed separately.
- The exact exit status matters and you do not want to block everything else on it.

Use the built-in bash tool for short, non-interactive, finite commands whose
entire output you want at once (e.g. \`ls\`, \`git status\`, a quick \`curl\`).

## Spawning

\`\`\`
pty_spawn({
  command: "bun",              // required
  args: ["run", "dev"],        // optional
  description: "Dev server",   // required, 5-10 words, used in listings and notifications
  workdir, env, title,         // optional
  notifyOnExit: true,          // push a <pty_exited> message when it finishes
  timeoutSeconds: 600          // hard cap; process is killed after it elapses
})
\`\`\`

The result contains the session \`id\` (\`pty_xxxxxxxx\`), the \`pid\` and the
initial \`status\` (\`running\`). Keep the id - every other tool needs it.

**Timeout policy**
- Do **not** set \`timeoutSeconds\` for processes that are supposed to keep
  running (dev servers, watchers, REPLs) unless the user explicitly asks.
- **Do** set it for long commands you are waiting on: builds, unit tests,
  E2E suites, migrations, downloads. It is a safety net, not a scheduler.

## Reading output

- \`pty_read({ id, offset, limit, pattern, ignoreCase })\` returns numbered
  lines from the buffer. \`pattern\` is a regex; when set, \`offset\`/\`limit\`
  apply to the matching lines. Default limit is 500 lines.
- \`pty_list()\` shows every session with status, PID and line count.
- Buffers survive process exit, so reading after a session ends is fine.

Prefer reading **after** the session finished (or when the user asks for live
output) over babysitting it.

## Waiting for completion

Two supported strategies. Pick one; never invent a third.

1. **\`pty_wait({ id, timeoutSeconds? })\` - preferred.** It blocks inside the
   tool call until the session exits and returns the exit code plus the tail of
   the output. This is the right choice when you need the result to continue:
   the agent stays busy, so the parent session never sees an idle subagent.
   \`timeoutSeconds\` turns it into \`<pty_wait_timeout>\` instead of blocking
   forever.
2. **\`notifyOnExit: true\` + the future \`<pty_exited>\` message.** Use this for
   fire-and-forget processes while you do other work. Do not poll while you
   wait. If the message never arrives (notifications are unavailable on some
   hosts), do not wait indefinitely - use \`pty_wait\` instead.

**Anti-patterns**
- \`sleep\` + \`pty_read\` loops to detect completion - always wrong.
- Repeated \`pty_read\` polling just to see whether it finished - use \`pty_wait\`.
- Assuming silence means "done" - check status with \`pty_list\` or \`pty_wait\`.

## Sending input

\`pty_write({ id, data })\` sends raw text. The PTY echoes input back, so you
will see it in the output stream. Useful sequences:

- Ctrl+C: \`"\\x03"\`
- Ctrl+D (EOF): \`"\\x04"\`
- Enter: \`"\\n"\` (or \`"\\r"\` for TUIs)
- Arrow keys / TUI navigation: the usual ANSI sequences (e.g. \`"\\x1b[A"\`).

For interactive prompts, write the value and then a newline. Shells only
execute a line once they receive it, so do not assume a command ran just
because you saw the echoed characters.

## Killing and cleanup

- \`pty_kill({ id })\` terminates a running process (SIGTERM) and **keeps** the
  session and its buffer for log access. Prefer this.
- \`cleanup: true\` removes the session entirely. It is **deprecated**:
  discarding finished sessions is a human action in the web UI. Do not discard
  sessions the human may still want to inspect.

Finished sessions accumulate in the list on purpose; a human prunes them. Do
not try to keep the list tidy by removing things.

## Timeouts, exit codes and failure diagnosis

- The \`<pty_exited>\` message and \`pty_wait\` result both include the exit code.
- Non-zero exit: read the tail first. If it is truncated or unclear, use
  \`pty_read\` with a \`pattern\` to grep for the error, then investigate.
- A session killed by \`timeoutSeconds\` reports as timed out; raise the timeout
  only if the command legitimately needs longer.

## Concurrency and lifecycle

- Multiple sessions run in parallel; each has its own buffer and id.
- Sessions are tagged with the session that spawned them. When an opencode
  session ends, its PTY sessions are cleaned up.
- Long-lived "dev server" style processes should be started once and reused,
  not respawned per request.

## Web UI (observer)

The plugin also serves a web UI (default port 4200, automatically moved to the
next free port if taken):

- \`/pty-open-background-spy\` opens the UI in a browser.
- \`/pty-show-server-url\` prints the actual URL (check this if 4200 was busy).
- The UI groups sessions into **Running** and **Finished**, shows live output,
  and lets a **human** kill or remove sessions. Agents do not need it; it exists
  for the user to watch and to prune finished sessions.

## Quick reference

| Need | Tool |
| --- | --- |
| Start a process | \`pty_spawn\` |
| Send keystrokes/input | \`pty_write\` |
| Look at output now | \`pty_read\` |
| Block until it exits | \`pty_wait\` |
| See all sessions | \`pty_list\` |
| Stop a process (keep logs) | \`pty_kill\` |
`,
}

/** Id the pty-usage skill is registered under. */
export const PTY_USAGE_SKILL_ID = 'pty-usage'

/**
 * Register the embedded skill with whichever API the host exposes.
 *
 * `source()` is the current one; the 2.0.x skill editor only knows `add()`. A
 * host with neither is reported and skipped: registering an optional skill must
 * never take the tools down with it.
 */
export function registerUsageSkill(
  draft: SkillDraft,
  log: PtyLogger = logPtyEvent
): 'source' | 'add' | 'none' {
  if (typeof draft.source === 'function') {
    draft.source({ type: 'embedded', skill: PTY_USAGE_SKILL })
    log('info', 'pty-usage skill registered via draft.source()')
    return 'source'
  }

  if (typeof draft.add === 'function') {
    draft.add({
      id: PTY_USAGE_SKILL_ID,
      name: PTY_USAGE_SKILL.name,
      ...(PTY_USAGE_SKILL.description === undefined
        ? {}
        : { description: PTY_USAGE_SKILL.description }),
      path: PTY_USAGE_SKILL.location,
      content: PTY_USAGE_SKILL.content,
    })
    log('info', 'pty-usage skill registered via draft.add()')
    return 'add'
  }

  log(
    'warn',
    'host skill draft exposes neither source() nor add(): the pty-usage skill is not registered'
  )
  return 'none'
}
