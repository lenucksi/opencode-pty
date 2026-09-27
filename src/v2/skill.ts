import { logPtyEvent, type PtyLogger } from '../plugin/pty/plugin-log.ts'
import { FALLBACK_TERMINAL_COLS, FALLBACK_TERMINAL_ROWS } from '../plugin/constants.ts'
import {
  CHARS_PER_TOKEN,
  DEFAULT_READ_MAX_TOKENS,
  MAX_READ_MAX_TOKENS,
  READ_MAX_TOKENS_CEILING_ENV,
  READ_MAX_TOKENS_ENV,
} from '../shared/constants.ts'
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
    'Use when a command needs a TTY: interactive prompts, long-running or background processes, TUIs (vim/htop), watching live output, or when the exit status matters. Covers pty_spawn/pty_write/pty_read/pty_wait/pty_list/pty_resize/pty_screen/pty_kill.',
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
  timeoutSeconds: 600,         // hard cap; process is killed after it elapses
  cols: 200, rows: 50          // optional; see "Terminal size" below
})
\`\`\`

The result contains the session \`id\` (\`pty_xxxxxxxx\`), the \`pid\` and the
initial \`status\` (\`running\`). Keep the id - every other tool needs it.

**Timeout policy**
- Do **not** set \`timeoutSeconds\` for processes that are supposed to keep
  running (dev servers, watchers, REPLs) unless the user explicitly asks.
- **Do** set it for long commands you are waiting on: builds, unit tests,
  E2E suites, migrations, downloads. It is a safety net, not a scheduler.

## Terminal size

The result reports the size it got: \`Size: 240x80\`.

- Without a terminal attached there is no honest "how wide would this run", so
  the default is a roomy ${FALLBACK_TERMINAL_COLS}x${FALLBACK_TERMINAL_ROWS}. Anything that
  formats a table, prints a wide line, or draws a full-screen UI is legible
  there; a narrow default makes all three look broken.
- If a human has the web UI open, a session started afterwards inherits the size
  of their terminal pane instead, because that is the geometry they are looking
  at.
- Pass \`cols\`/\`rows\` to \`pty_spawn\` when the program cares. This is the reliable
  route: a program that reads its size once, at startup, will not react to a
  later resize.
- \`pty_resize({ id, cols?, rows? })\` changes the geometry of a running session.
  Omitting a dimension leaves it alone. The result reports the size that was
  actually set, which is not always what you asked for - out-of-range values are
  clamped.
- \`pty_list\` shows each session's current size.

Wrapping in the output is a geometry problem until proven otherwise. A table
folded onto three lines usually means the program was given fewer columns than
it wanted, not that the table is malformed.

## Reading output

- \`pty_read({ id, offset, limit, pattern, ignoreCase, maxTokens, all })\`
  returns numbered lines from the buffer. \`pattern\` is a regex; when set,
  \`offset\`/\`limit\` apply to the matching lines. Default limit is 500 lines.
- \`pty_list()\` shows every session with status, PID, line count and char
  count. A large char count with a small line count means the output is one very
  long line - typically a TUI repainting its screen as escape sequences, or
  minified/compiled data. \`pty_read\` on such a session returns a single
  enormous line, which is a different situation from a build log.
- Buffers survive process exit, so reading after a session ends is fine.
- \`pattern\` is rejected with an error when it looks like catastrophic
  backtracking (nested repeated groups, stacked non-greedy quantifiers, long
  alternations). If a filter is rejected, simplify it or fetch the window first
  and filter in your own reasoning.

### The read budget, and how to page through what it withheld

A result is capped at **${DEFAULT_READ_MAX_TOKENS} tokens** (about ${DEFAULT_READ_MAX_TOKENS * CHARS_PER_TOKEN} characters) unless you ask for more with \`maxTokens\`, which is itself capped at ${MAX_READ_MAX_TOKENS} tokens. \`all: true\` removes the cap entirely and is a last resort - it can overflow your context.

The cap applies to the **whole result**, not to each line. Lines are returned
whole until the budget runs out, and at most one line is cut.

When the budget bites, the \`<pty_output>\` tag says so:

\`\`\`
<pty_output id="pty_x" status="running" truncated="true" truncatedLines="1"
            nextSince="100000" chars="100000/248225">
00001| ...
00002| <cut here> … [truncated: 0 of 59760 chars]
</pty_output>
\`\`\`

- \`truncated="true"\` - a line was cut. Never read that as the end of the data.
- \`chars="X/Y"\` - X characters delivered of Y retained in the buffer.
- \`nextSince="N"\` - the exact character offset this result stopped at.

To continue **without losing or repeating a character**, read with
\`pty_read({ id, since: N })\` and follow each \`nextSince\` until the tag
omits it. Re-assembling the chunks reproduces the output exactly, including a
line that was cut mid-way. \`offset\`/\`limit\` remain useful for line-oriented
output such as build logs, but they cannot resume inside a cut line - if a
\`truncated="true"\` result contains something you need in full, use \`since\`.

\`offset\` and \`since\` are mutually exclusive; \`since\` wins. The defaults
are environment variables: \`${READ_MAX_TOKENS_ENV}\` sets the default budget and
\`${READ_MAX_TOKENS_CEILING_ENV}\` the maximum a caller may request.

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

## Seeing a screen, not a stream

\`pty_screen({ id, colors?, width?, height? })\` returns what a human would see:
the two-dimensional screen, the cursor position, and optionally the colour and
style of every run of cells that differ from the default.

Use it when the *layout* is the question - a TUI, a pager, \`top\`, \`htop\`, a
progress display, a diff viewer, a wizard. For ordinary line output such as a
build log, \`pty_read\` is cheaper and its line numbers match what the process
printed.

\`\`\`
<pty_screen id="pty_x" cols="80" rows="24" cursor="12,5" visible="true"
            alternate="false" scrollback="0">
01| Deploying to staging
...
</pty_screen>
\`\`\`

The body is the screen, one row per line, each prefixed with its row number. With
\`colors: true\` a \`<pty_spans>\` block follows, listing runs as
\`row col length style\` - a location and a style, so a highlight can be matched
against the row above it.

What the tags mean:
- \`alternate="true"\` - the program is on the alternate screen (vim, htop, less).
  There is no history there; \`pty_read\` for the full stream.
- \`scrollback="N"\` - N lines above the screen. Read them with \`pty_read\`; they
  are not part of the screen.
- \`partial="X/Y"\` - only the last X of Y retained characters were replayed. The
  screen is a reconstruction; a row the program painted long ago and never touched
  again may be missing. Prefer \`pty_read\` when you need the whole history.
- \`requested="CxR"\` - you asked for a screen larger than the render budget allows,
  so this is the scaled-down version. The proportions are preserved.

\`width\`/\`height\` render at a size you choose without touching the session. That
is the cheap way to answer "how does this behave on a narrow terminal", and it
costs no respawn.

Prefer \`pty_read\` first and \`pty_screen\` when the read shows the output is
painting a screen: escape sequences, a single enormous line, or a \`pty_list\`
character count far larger than the line count. A large character count with
almost no lines is the signature of a program that repaints its screen.

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

The plugin also serves a web UI for a **human** to watch the sessions.

- The port is chosen by the OS (ephemeral) unless the host configured a fixed
  one, so it does not collide with a development server. An explicitly
  configured port is moved to the next free one when it is already taken.
- \`/pty-open-background-spy\` opens the UI in a browser.
- \`/pty-show-server-url\` prints the URL that is actually in use. Call it when
  you need to tell the user where the UI lives, or to check a session whose ids
  predate the current boot.
- The UI groups sessions by their parent OpenCode session, separates **Running**
  from **Finished**, streams live output, and lets the human kill or discard
  sessions. Agents do not need it: it exists for the user to observe and prune.

## Quick reference

| Need | Tool |
| --- | --- |
| Start a process | \`pty_spawn\` |
| Send keystrokes/input | \`pty_write\` |
| Look at output now | \`pty_read\` |
| See what the screen looks like | \`pty_screen\` |
| Block until it exits | \`pty_wait\` |
| See all sessions | \`pty_list\` |
| Change the terminal size | \`pty_resize\` |
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
