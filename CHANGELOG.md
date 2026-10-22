# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-10-22

The line that makes the daemon the core and everything else a client of it. The
claim is the one the README has been making for a while: **tmux, but
agent-native** - a real terminal, a session that outlives the agent, and the same
tools whichever harness asks.

### Added

**The PTY tools over MCP**

A harness that speaks MCP cannot use a plugin, so the tools are served over
stdio: `opencode-pty-mcp`, a bin next to the plugin. It is a dispatcher and a
startup hook, not a rewrite - the handlers are the same modules the plugin
registers, the schema of every tool comes out of the tool's own zod shape, and the
daemon is what they talk to. A session an MCP client starts is a session the
OpenCode plugin lists, because it is the same daemon.

What differs is the route's own: the texts, the permission gate and the
completion signal. The tool descriptions come from one file per tool with the
differing parts filled in by the route, so the OpenCode route keeps telling a
model about the `<pty_exited>` message and the MCP route tells it that there is
none - a model that was told to expect a message and gets none waits for
nothing. The usage guide follows the route too, and is offered as an MCP prompt.

**The web interface on its own**

`opencode-pty-web` serves the existing interface against the daemon and prints
the address once, for a human who wants to watch a harness that is not OpenCode.
The daemon is the state, so it shows the same sessions an OpenCode instance
would, and a machine with no daemon gets one started rather than an error.

**A version on the wire**

The daemon outlives the host, so a new plugin can meet a daemon that was started
long ago. The protocol carries a version, and a client that meets a daemon of
another version says so instead of discovering it as a missing method.

### Fixed

**The permission gate asked nobody**

The V2 route had **no** gate: the adapter was never given an authorizer, so the
check was a no-op and the plugin could start anything. The README's claim that it
respects `permission.bash` was true of the V1 plugin only.

Inside OpenCode the model's tool calls now go through the host's own permission
system: the same rules the built-in `bash` tool obeys, and the same prompt. "Ask"
asks the user instead of being turned into "deny" - the V1 route had to deny,
because a plugin could not ask a human anything.

A route that cannot ask the host - the web interface, a browser - enforces a
policy of its own: the same patterns and the same semantics, read from the user's
own OpenCode configuration, with "ask" refused because there is nobody to ask.

**A screen read over the socket was empty**

The daemon did not await an asynchronous handler, and the screen renderer is one.
A promise on the wire is `{}` after `JSON.stringify`, so every `pty_screen` over
the daemon answered with an empty object. The in-process route never noticed,
because there the tool awaits the manager itself.

**A request that arrived during a reconnect went nowhere**

Two connections at once - the reconnect and the request - and the second replaced
the first, so the answer arrived on a socket nobody read. And the requests that
were in flight when the daemon died waited for their timeout, which says nothing
about what happened; they are refused now, with the reason.

**A machine on which the daemon had never run could not start one**

The start lock lives beside the socket, and on such a machine that directory does
not exist - so the lock could not be taken, and a lock that is never held is a
daemon nobody starts.

### Changed

- **The V1 plugin is gone.** The bare package name loads the V2 half, so
  `"plugin": ["opencode-pty"]` and `"plugin": ["opencode-pty/v2"]` are the same
  plugin, and OpenCode 1.x is no longer supported. One shape of one plugin, and
  the configuration that named the wrong one cannot break silently any more.
- **`pty_screen` takes a bound.** The default is the whole live ring buffer - a
  program that painted a row once and never touched it again must still be in the
  replay - and an archived transcript is replayed from the last 4 MB. A narrower
  window is a reconstruction, and the result says how much of the session it
  covered. The buffer is untouched either way.
- **A wait answers.** On MCP the wait is the completion signal, and it is capped
  below the transport's own limit, with a progress notification while it runs. The
  OpenCode route is unchanged: it blocks, as it always did.
- `notifyOnExit` is accepted on the MCP route and has no effect there, and the
  spawn result says so.

## [0.9.1] - 2026-10-22

### Added

**A slash command that says what it did**

The host executes a command and drops whatever it returned - the contract is
`Effect<void>` - so `/pty-daemon-restart` did its work and said nothing, and
`/pty-show-server-url` published a URL nobody could see. The two halves of this
plugin already meet over its own RPC, so that is where the answer goes now: the
server half emits a notice, the TUI half turns it into a toast. A command that
works and a command that did nothing look the same from the outside; they do not
any more.

### Fixed

**The daemon rolls once, and the machine is left with one daemon**

A restart ended in `Daemon did not start` and a red toast, and the machine was
left with three daemons: one holding the socket path, two listening on an inode
nobody can reach. The cause was a race, and every part of it was a decision made
twice:

- The restart removed the socket path without asking whether a daemon was
  listening on it. A path with a live daemon behind it belongs to that daemon:
  removing it does not stop the daemon, it makes it unreachable.
- Every opencode instance on the machine talks to the same daemon, and every one
  of them started one when the socket was missing. Two clients that each spawn a
  daemon leave a loser behind - and the loser is the one that unlinks the
  winner's socket.
- The daemon that lost the path could not notice: it cannot see the path any
  more, and the pid file is a note about it rather than the truth. The inode
  under the name is the truth, and it is what the daemon compares itself against
  now. A daemon that was superseded retires instead of holding on.
- The second daemon's bind could fail with `EADDRINUSE` and take the machine's
  log down with a crash dump. It steps aside now.

Starting the daemon is a machine-wide decision, so it is locked across processes:
one client starts, the others wait for the socket. The daemon says who it is, so
the restart asks it for its pid instead of believing a file, and a daemon that
owns the path keeps that file in step.

The failure names the socket and the log instead of saying `did not start`, and
the command reports what it did - with the daemon's new pid, which is the only
way to tell a restart from a no-op.

### Changed

**The sideways bar is a bar, not a line of text between two arrows**

A reader could not tell the row for a scrollbar: it said `0-82 of 200 cells`
between two arrow glyphs, and nothing about that said "this moves". The row is
now a track across the whole width with a thumb on it at the position the reader
is at, the counter on the track, and the arrows at the ends - all on the track's
own background, so it reads as one control. The track is a box with a background
rather than a run of spaces, so it covers the row whatever the measured width
turns out to be; only the thumb's geometry is computed, and that is a pure
function now - a thumb one cell off is a picture that still looks like a
picture.

**The console has neither a border nor a background**

The border glyphs around the framed screen are selectable cells, and they
confused the terminal's selection algorithm; the raised background made empty
cells count as non-empty for the same reason. Both are gone, the padding is
symmetric, and the console gained the two columns that the frame used to take.

### Tooling

- Publishing is a repository's own decision again: the release workflow asks the
  repository whether it publishes, so a fork is not shut out of its own releases
  by a hardcoded name.
- The daemon's request table and the client's start logic moved into modules of
  their own, because both files had grown past the size the repository asks for.
- New: cases for the daemon that outlives a restart - a daemon whose path was
  taken over retires, two clients that connect at once start one daemon, a
  restart does not take the socket away from the daemon that answers on it, and
  the daemon that answers is the one that gets stopped.

## [0.9.0] - 2026-10-21

### Added

**The daemon can be rolled without a shell**

A rebuilt daemon does not take effect on a host restart — outliving the host is the
point — so rolling it meant finding the pid file and sending a signal by hand.
`/pty-daemon-restart` (and `PtyClient.restartDaemon`) now stops the running daemon,
waits for its socket to go, and connects again, which starts a fresh one. It reports
both pids. It ends every session the daemon owns, and its description says so: the
PTY masters belong to that process.

**The TUI console scrolls sideways**

A session draws its screen for the terminal it was started with. The panel is a
fraction of that, and everything past its right edge was unreachable: opentui's
scrollbox cannot scroll sideways, because its scroll size is the content's
*computed* width — which is the viewport's, so it never has more to show than it
already does. The offset is the panel's own now: the console is cut to a cell
window, with the colour runs cut along with their characters and a double-width
character at the edge kept whole. A bar under the console carries the position and
two arrows, and appears only when the screen does not fit.

The panel footer also names the keys that work while it is focused — `f3`
fullscreen, `f4` send, `ctrl+y` close — and only then, because the host owns the
input scope and an unfocused panel answers none of them.

### Fixed

**A response larger than the socket buffer was truncated**

`pty_list` timed out with a few hundred archived sessions while `ping` answered:
the daemon wrote its response with one `socket.write`, which accepts what fits and
drops the rest. The session list is about 350 kB, so the client received a JSON
object cut mid-string, never saw a newline, and gave up. Writes now go through a
queue that flushes again on `drain`, on both sides, so a large `pty_list`, a large
read or a large `pty_write` arrives whole.

**Half the plugin still talked to the in-process manager**

`pty_wait` asked the in-process manager for a session it had just spawned through
the daemon, got nothing, and reported `<pty_session_lost>` for a process that was
running the whole time. The WebSocket handler spawned, wrote and resized on the
in-process manager as well, so a daemon-backed web UI streamed nothing; session
deletion cleaned up the wrong store; and the notifier was installed where the
daemon's exit pushes could not reach it. All four now go through the active
manager.

**Screens were rendered from the last 256 kB and lost the top**

A full-screen program repaints only what changed, so a window over its output
leaves every row painted before the window blank: a live htop showed its process
table but not its header, and btop lost its left edge. Measured: 256 kB produced
fragments, the whole 1.2 MB buffer produced the real screen, at about the same
cost. The screen is rendered from the whole ring buffer now (archives: the last
4 MB, and a shorter replay says so). It is also rendered where the buffer lives,
so the wire carries cells rather than megabytes, and a slow read keeps the last
frame of the session on screen instead of replacing it with an `AbortError`.

**The sidebar list reloaded on every poll and emptied on a failure**

Each poll replaced the session list with a freshly parsed array, so all rows were
new objects and the sidebar rebuilt itself every 2.5 s; a failed poll replaced the
list with nothing, which the reader saw as the list blanking and refilling. The
identity merge that the panel had (with a guard that was dead code) is shared now,
a failed refresh keeps the rows and says the server is unreachable, and the parent
conversation titles are read untracked so the host's session store no longer
rebuilds the list on every token of every conversation.

**A client that reconnected inherited the previous connection's half-line**

A truncated response left an unterminated line in the buffer, and every later
response was appended to it and dropped. The buffer is cleared on close and on a
successful connect.

**Smaller ones**

- `disconnect()` armed a reconnect, so every finished run started a fresh stray
  daemon a second later; an intentional end no longer reconnects.
- Two daemons starting at once could split-brain: the loser unlinked the winner's
  socket. A daemon now probes an existing socket and exits if something answers,
  and the client's start is single-flight.
- The daemon entry resolved to a `.js` beside the client, which does not exist in a
  source checkout; it falls back to the `.ts` entry.
- The daemon launcher interpolated paths into `sh -c`, where a path containing
  `$(...)` would expand. It spawns `setsid` with an argument vector now.

### Changed

- `@opencode/plugin` and `@opencode/theme` 2.0.29 → 2.0.32, the version the host
  runs; the peer floor for `@opencode/theme` follows the SDK's.
- The client is split into a transport half and an API half, and the daemon's
  request switch is a handler table.
- Screen reads ask the manager for the screen instead of transferring the raw
  buffer, so the Web UI, the TUI and `pty_screen` all take the same path.

### Tooling

- Aislop 94 → 100/100 with no warnings, Biome warnings 47 → 0, and the `any` in the
  IPC layer replaced by the manager's own types.
- Coverage gaps closed where the daemon work landed (archive-trash, the v2
  commands, the client API), held at the per-file 80 % gate.
- New: an opencode-in-the-loop daemon survival harness — two real hosts, one
  daemon — run with `bun run test:daemon`; `--dry-run` drives the daemon through
  two clients without a model.

## [0.8.0] - 2026-10-19

### Added

**PTY sessions survive an opencode restart**

A session's process used to die with the opencode server that spawned it: the PTY
lived in the plugin's process, and every restart took the dev server, the watcher
and the serial console with it. An opt-in daemon now owns them instead.

Set `daemon: true` in the plugin options (or `PTY_DAEMON=1`) and the plugin
connects to `opencode-ptyd` over a Unix socket, auto-starting it with
`setsid`+`nohup` when it is not running. The daemon keeps the sessions, the
archive and the generation; the plugin becomes an IPC client that forwards the
eight tools and the web UI's handlers to it. Output, status changes, removals and
exit notifications are pushed back over the same socket.

Tools, Web UI and TUI panel all read through the active manager, so they show the
daemon's sessions rather than an empty in-process list. Defaults are unchanged:
without the option the plugin runs in-process exactly as before.

Reliability details that are not obvious:

- Delivery is heartbeat-based, not PID-based: the client pings every 30 s and the
  daemon lingers an hour after the last client leaves, which is what lets it
  outlive a restart without leaking forever.
- A stale socket (file present, nothing listening) is removed and the daemon
  restarted, so a crash is not a permanent dead end.
- A dropped connection reconnects with exponential backoff and re-registers the
  push handlers.
- The daemon entry and state dir are resolved relative to the module and
  `sessionsRoot()`, and the child's stderr goes to the PTY log - a daemon that
  cannot start now says why.

See `docs/daemon.md` and `docs/daemon-test-scenarios.md`.

## [0.7.1] - 2026-10-17

### Fixed

**The TUI session panel draws the colours the program used**

The panel rendered a session's screen as plain text, so a program that paints - the
UEFI boot menu, `ls --color`, `htop` - arrived in black and white while the same
session was coloured in the web UI. The colour was never missing on the wire: the
server's screen render already resolved every cell's foreground, background and
attributes. It was dropped twice on the way to the panel - once when the decoder
kept only the rows, and once when the renderer drew one plain string.

The response now carries `styledLines`: the same runs as `spans`, but as text, so a
consumer without a terminal of its own can place the characters (a wide character is
one character and two cells, which is why cell coordinates alone were not enough).
The panel draws one `<text>` per run in a row box. Background padding survives - the
boot menu's blue box is a run of spaces carrying a background - while plain trailing
padding is still trimmed.

## [0.7.0] - 2026-10-17

### Added

**`raw` spawn option for PTY sessions**

`pty_spawn` and the session-creation API accept `raw: true`, which disables the
PTY slave's line discipline (`stty raw -echo`) before the command runs. Use it for
a serial console (`virsh console`), a boot menu, or any program that expects a
`\r` to stay a `\r`.

Without it, the kernel's cooked discipline applies ICRNL and delivers Enter as
`\n`. A libvirt serial console showed its boot menu and relayed arrow keys, but
Enter did nothing - the byte was written and the program never saw it. Arrow keys
are escape sequences and are not translated, which is why only Enter was affected.
Raw mode turns ICRNL, ICANON, ISIG and ECHO off, so bytes arrive verbatim. It is
opt-in because a shell would lose line editing and the interrupt key.

`pty_list` and the `<pty_spawned>` result now report whether a session is raw.

### Fixed

- Enter works on a serial console reached through `pty_spawn`: the new `raw` option
  stops the line discipline from rewriting a carriage return into a line feed.

## [0.6.0] - 2026-10-15

### Added

**TUI sidebar panel**

A PTY section in OpenCode's terminal sidebar, listing this project's sessions and
opening a session's live output in a dialog. Contributed additively through the
V2 TUI plugin API (`Plugin.define` plus the `sidebar.content` slot), so it sits
beside the built-in sidebar items rather than replacing them.

- The server publishes its bound address to a small record under
  `$XDG_RUNTIME_DIR/opencode-pty/`, which is how the panel finds it. A reader
  validates every candidate with `/health`, and the owner removes its own record
  on shutdown.
- Sessions now record `exitAt`: when the process actually stopped, as opposed to
  `endedAt`, which is written from the exit notification and lost on a restart. It
  travels into the archive, which is what lets the dialog show a finished run's
  duration.
- The panel polls rather than subscribing: the web UI has a WebSocket for this and
  a TUI has no equivalent, so `POLL_MS` is the floor for how stale it may look.
- The list is ordered with running sessions first, then finished ones newest first.
  It holds every session the server knows, which on a machine with any history is
  hundreds of records - and a live process below all of them is one you have to
  scroll to find. The header's count stays the true total, so nothing is hidden.
- Once a start has failed repeatedly, the status names the gesture that still works
  (toggle the panel again) rather than inviting a click that no longer starts
  anything.
- **The sidebar lists the running sessions, and the archive is one click away in the
  footer.** Measured on the author's machine the list held 200 entries in a ~40-column
  sidebar, of which three carried news (`exit 1`, `exit 2`) and 197 were `exit 0`; the
  section also displaced the host's own MCP and LSP sections. Ordering could not fix
  that, because a status strip cannot be a session manager. So `sidebar.content` draws
  one row per RUNNING session - or one dim line saying nothing is running - and a new
  `sidebar.footer` slot carries the archive's size. Clicking that line expands the
  finished runs that FAILED, newest first, capped at 10. An `exit 0` is a record, not
  an event: on a machine with history there are hundreds of them, and the only place
  they are still browsable is the web UI. The header's count stays the true total, and
  the footer names the archive rather than the rows on screen - when the cap cuts the
  list it says so (`10 of 17 failed`). The line is absent when nothing failed, because
  a click that opens nothing is a control with no answer.
- Opening the archive does not start a server. Expanding the panel is the only trigger
  that does, and the sessions the archive shows are already in the panel state, so the
  expansion needs no refresh at all.
- **The sidebar has a filter, driven by the host's own prompt.** `/pty-filter` asks for a
  query through `ui.dialog.prompt` and stores it beside the collapsed flag, so the plugin
  needs no text field and no key handling of its own. Matching is the SHARED rule
  (`filterGroups`/`sessionMatches`) rather than a second matcher that would drift:
  case-insensitive, over the conversation heading and every field a row shows, with a heading
  match keeping its whole group. To let the panel use it, those functions are now constrained
  on the fields they READ rather than on `PTYSessionInfo` - the same move `TimeOrdered` was -
  because the panel carries a trimmed shape across a process boundary and its `args` is
  optional, so the haystack tolerates a session with no command line at all. The header reads
  `N of 200` while a filter is active, the query appears beside it as a clickable chip (the
  way to clear it that needs no typing), and an empty body names the query instead of
  claiming nothing is running. A dismissed prompt leaves the filter alone; an empty answer
  clears it. The numerator counts what the body draws, so `0 of 200` and "nothing matches"
  cannot contradict each other.
- **The sidebar groups the running sessions by the conversation that started them.** The
  list was global: a conversation that had started no PTY still saw the whole machine's
  sessions, and without the parent id by heart there was no way to tell whose process a row
  was. Each group now carries one collapsible heading, titled through the host's own
  `data.session.get` and falling back to `Session <id>` - or `Ungrouped` for a session
  started by hand - with the same agent name the web sidebar shows. The fold is the host MCP
  sidebar's idiom, copied: ONE mouse handler, on a chevron that appears only once a group is
  big enough for folding to save something. A group of one or two is therefore always open,
  so the collapse can never take the one live process out of sight. A group holding a
  running session is drawn above one that only finished, and the group state is a durable
  preference beside the collapsed flag. The grouping applies to the running set - the
  archive in the footer stays a single count, because 200 sessions across 20 conversations
  would be a wall of headings in a ~40-column sidebar.
- The output dialog uses a plain box rather than a scrollbox. Measured against
  opentui 0.5.14: a scrollbox renders nothing when its text contains a line break,
  and `stickyScroll` together with `stickyStart: 'bottom'` blanks it even for a
  single line. The box shows exactly as many lines as it has rows, so the newest
  output is what lands on screen. The full history stays in the web UI.
- `opencode-pty/v2` now also resolves `/tui`. OpenCode builds the TUI specifier from
  the configured plugin name, so the documented V2 entry was probed as
  `opencode-pty/v2/tui` and the panel was never found - while the tools loaded
  normally, which is what makes it a silent failure. Found by running OpenCode's own
  resolver against the built package.
- `opencode-pty/tui` is now a declared export. The `exports` wildcards did not reach
  it - `./*` matches one path segment and pointed at `dist/src/tui.js` rather than
  the directory's `index.js` - so opencode's resolver reported the plugin as having
  no TUI feature, which reads as "the panel never appears" rather than as a
  packaging mistake.
- `@babel/core`, pulled in by `@opentui/solid`'s Babel plugin, is overridden past
  advisory GHSA-4. Nothing here runs Babel; only `jsx-runtime` is used.

- **The session list is ordered by `exitAt`, in the browser as well as the sidebar.**
  `endedAt` is lost across a restart - that is the reason `exitAt` exists - so a restarted
  session had no end time and fell back to its start when the list was ordered. A session
  that finished twenty minutes ago therefore sorted ABOVE one that finished a minute ago,
  on every surface. `sortSessionsByTime` now prefers `exitAt`, then `endedAt`, then
  `createdAt`.
- **One duration formatter with two presets.** `formatDurationMs` is the implementation;
  `compact` gives `2h 04m` for the web sidebar and `precise` gives `1m 05s` for the 40-column
  one, both from the same arithmetic. The sidebar's run timer is no longer a second
  implementation, and two surfaces can no longer disagree about how long a run was.
  One deliberate behaviour change: a duration of zero or less now renders as EMPTY rather
  than `0s`, because `0s` claimed a run lasted nothing on a clock that cannot be trusted -
  and the callers already render the empty case deliberately.
- The sidebar panel's ordering is now the shared rule plus one step of its own. The
  partition (running above finished) stays local, because a live process below a page of
  records is one you have to scroll to find. The order inside each half comes from the
  shared sort, which also brought its deterministic tie-break: two sessions with the same
  timestamp are separated by id rather than by whichever order the server sent them in.
- **A `session.panel` for the PTYs of the conversation you are in.** A PTY session belongs to
  the OpenCode session that spawned it - the web UI groups its list by `parentSessionId` for
  the same reason - so the panel claims `session.panel`, the host's own place for an extra
  view of a session, where Review and Files already live. Open it from the command palette
  or `/pty-sessions`; no keybind is configured, because any guess could collide with the
  host's own and the command has an id for the user's keymap config.
  It lists this conversation's processes, one on screen, read on the same poll as the
  sidebar - the panel's rows are a subset of that list, so a second fetch would be a second
  answer to a question already answered.

- **The freshness check asks the registry about the version a bump would take.** `bun outdated`
  prints Current, Update and Latest, and the age lookup read only Update. For an exactly-pinned
  dependency Update is the CURRENT version - there is nothing `bun update` can install inside
  an exact pin - so the lookup returned an age of months and the gate could never wait such a
  release out. It demanded a same-day bump instead, which is the outcome `minimumReleaseAge`
  exists to prevent, and the failure AGENTS.md records as "a gate stricter than the policy it
  enforces will fail on every publish". One package gave two answers in the same run: the
  `@opencode/theme` `(dev)` row looked up 2.0.23 and failed, the `(peer)` row looked up 2.0.24
  and waited it out. The target is now Update when it differs from Current, Latest otherwise.
  `publishedAt` receives that version instead of the row, so which version is asked about is
  assertable rather than something a test has to re-derive by parsing the table itself.
- **`seroval` is overridden past a critical advisory that `solid-js` pins into the lockfile.**
  `seroval@1.5.6` carries GHSA-mv8w… (thenable assimilation, critical) plus a high one, and
  `solid-js@1.9.15` pins `~1.5.4` for both `seroval` and `seroval-plugins`. Only
  `solid-js/web/dist/server.js` imports it - Solid's SSR build, and nothing in a terminal
  plugin renders HTML - so both `bun audit` and Aislop's own
  `security/vulnerable-dependency` rule were failing on code this package cannot reach.
  Narrowing `bun audit` to `--production` was the first attempt and the wrong one: it would
  have quieted one tool while leaving Aislop's rule unsatisfied, for an advisory still
  installed. The override fixes both, and it sits inside the contract rather than past it -
  `seroval-plugins` declares `seroval` as a peer of `^1.0`, so 1.6.8 is a version its own
  package asks a consumer for. `bun audit` now reports no vulnerabilities across 430
  packages. Same shape and same expiry as the existing `@babel/core` override:
  `test/tui-package.test.ts` pins both values, and the override goes when `solid-js` ships a
  fixed pin.
- **Clicking a row in the sidebar opens the panel — the row had no click handler at all.**
  Reported as "clicking a running session should open the panel too", and the reason it did
  not is worth recording: `PanelView.onOpen` existed, was wired to a row, and no row ever
  called it. Only the remove glyph carried a mouse handler, so `onOpen` was unreachable from
  a row and the output could be opened from the palette and nowhere else. A prop that nothing
  renders is not a wired prop. The row now opens on mouse-UP, with the mouse-DOWN stopped so
  the press half cannot reach the section's own collapse toggle.
- **The panel can drive the process on screen, through a command line rather than keys.** A
  plugin gets named commands and no raw key events, so forwarding keystrokes would mean
  binding every printable key - and `q`, the quit key of every full-screen program, belongs
  to OpenCode's `diff.close`, whose command carries no `enabled` predicate and is therefore
  live at all times. `ui.dialog.prompt` is the input the SDK genuinely offers, so `⌨ send` in
  the header and `f4` open it, and the line is written to `/api/sessions/:id/input` with a
  newline. `top` is fully usable this way. It is a command line, not a terminal: arrow keys
  and raw control characters remain out of reach, and `htop` needs key handling this SDK does
  not expose. The origin is resolved BEFORE the prompt opens - a test caught the earlier order,
  which asked a reader with no server to talk to for input that could not be delivered.
- **The panel has a footer, mirroring the web UI's identifiers-above-counters-below.** Id,
  status, terminal size, output lines and the rendered screen's row count. Size and line count
  are the ones that matter for a full-screen program: `top` given 120x40 and shown in 80
  columns is wrapping, not a rendering fault. It is the framed screen's SIBLING, not a child,
  because the screen grows to fill and a bar inside it would be pushed off the bottom.
- **The panel's keys are exactly three, and two of them are keys the host left free.**
  `ctrl+y` closes the panel and `f3` enlarges it; both also appear in the palette, which is
  the route that cannot be taken away. Switching sessions deliberately has no key: OpenCode
  has `session.list` on `<leader>l` and closes this panel as a side effect of leaving, so a
  key here would only shadow a binding that already works. The obvious choices for "leave
  this" were both taken - `escape` is `session.interrupt`, and `q` is `diff.close`, whose
  command carries no `enabled` predicate and is therefore reachable at any time. Measured, of
  the 167 binds in the host's keybind config.
  `toggleFullscreen` exists only on `PanelInput`, which arrives inside the slot's render and
  nowhere else - `ui.panel` is just `open`, `close` and `current` - so the claim records the
  function it was handed and the key drives that.
- **The session panel has a way out. It did not have one, and a reader reported the
  consequence.** OpenCode has no key for closing a plugin panel: all four `panels.close()`
  call sites in the TUI are side effects of something else - changing session, selecting a
  terminal, opening the sidebar - so every route out of the panel was a DIFFERENT action
  that happened to close it. Opening `/pty-sessions` therefore left a reader with a panel
  they could not leave, and the only remaining move was killing the terminal. Three exits
  now exist: a palette entry, `ctrl+y` (the command's id is
  `opencode-pty.session-panel.close`, so it can be moved), and a `✕ close` control in the
  panel header. The key is only live while a panel is open, because a binding that does
  nothing the rest of the time teaches the reader to distrust the one time it matters.
- **The panel's screen box fills the panel instead of claiming a row count.** It computed
  half of `renderer.height` - the TERMINAL's height - and asked for that many rows inside a
  panel far smaller, so the box overflowed the session view rather than filling it; a
  reader reported the panel ignoring the available length. It now grows, which is both
  correct and what the host's own terminal pane does. `panelScreenRows` is gone.
- **An empty panel no longer draws an empty black rectangle.** The framed screen is drawn
  only when a session is selected. Next to the sentence explaining that the conversation
  started nothing, a large empty frame read as a rendering failure rather than an absence.
  **It is read-only, and that is the SDK's ceiling rather than a choice.** `context.keymap`
  offers exactly `layer()`, `dispatch()` and `shortcuts()`, so a plugin can bind named
  commands and nothing else; there is no access to raw key events, and the host's own
  terminal pane gets one through an internal TUI context a plugin does not receive. So
  `pty_write` from free typing, scrolling the output and resizing are unreachable from a TUI
  plugin on this version. What the panel adds over the dialog is that it is not modal, that
  it is wider, and that it shows the processes of the conversation you are reading.
- The theme's six colour slots are read in one place instead of four. Three surfaces draw
  with them, and three copies of a palette is three places for a rename to miss.
- **The panel's output dialog reads that screen instead of the plain buffer.** It asked
  `/api/sessions/:id/buffer/plain`, which is `Bun.stripANSI(raw)`: the colour codes go and
  the cursor movement goes with them, so a full-screen program's output arrived unpainted
  with its layout gone - every repaint on its own line. The dialog now reads the screen
  endpoint, which replays the same bytes through the same VT emulator `pty_screen` uses.
  Measured on `printf '%b' 'top\r\nsecond\r\n\e[3;7Hmoved'`: the plain buffer yields
  `moved`, the screen yields `      moved`. The rows are kept as they are, trailing blank
  rows included, so a line too wide for the terminal occupies two rows in the dialog
  exactly as it does on the terminal. `buffer/plain` itself is untouched - it is the right
  answer to "what bytes did the program write", and `pty_read` and the web UI both depend
  on it.
- `GET /api/sessions/:id/screen` returns the rendered screen - lines, cursor,
  colour spans - for a session. `buffer/plain` answers "what bytes did the program
  write" and is unchanged: it is the ANSI-stripped byte stream, which is the right
  answer to that question and what `pty_read` depends on. The new route answers
  "what does it look like?", which that one cannot: the layout of a full-screen
  program lives in the escape sequences, so stripping them leaves every repaint as
  text on its own line. The web UI never needed this - it reconstructs the screen on
  the client from the raw buffer - but a TUI plugin has no DOM and no renderer of
  its own, so the server has to do the replay. It is the same `renderScreen` call
  `pty_screen` makes, at the same geometry, and `?cols`/`?rows` render at another
  size without resizing the session.

### Changed

- `@opentui/core`, `@opentui/solid`, `solid-js` and `@opencode/theme` are optional
  peer dependencies, at the floors `@opencode/plugin` itself declares. They are
  also development dependencies, so the TUI contract is type-checked in CI. A host
  with no TUI can still install this package.

### Fixed

- **The poll stopped twitching the panel.** Every poll tick handed the panel state a list the
  server had just built - the same CONTENT, but a new array of new objects every time - and the
  claim's render spread the whole state into its reactive scope, which tracks every field: a tick
  that only moved the clock re-laid the panel out. Two halves, same rule: a list-note now carries
  over the rows it already shows (a row whose fields did not move keeps its object identity, a
  changed row is the only one re-handed), and the claim hands the view the store rather than a copy,
  so a watcher re-renders only what its field moved. Measured as a state rule and red-proved by
  name ("keeps the rows' identity...").
- **The send dialog's key chips fit a medium dialog.** At 60 columns (the width `dialogWidth`
  hands a medium dialog) the chips row was longer than the dialog, and the reader measured the last
  chip (`Enter`) running out at the edge - a wider test width had hidden it. The row wraps (the
  host's own dialogs do, via `flexDrop`), the hint moved to the footer, and a narrow-width render
  asserts every label drawn inside the box.
- **The console now scrolls the history the emulator was holding, and stops selling blank
  rows as content.** `/screen` answered with the visible screen only, so a line printed moments
  ago left the panel's console for good - measured, the emulator HELD 103 scrollback rows for the
  same session the `/screen` was answering with 81 screen rows, and the web UI scrolled all the
  way up through the full transcript. The route now takes `?scrollback=<n>` (default 0, so
  `pty_screen` and the web's client keep their exact shape) and prepends the older rows, oldest
  first, within the replay window; the response says how many it added. The panel asks for the
  history. And the consumer drops the trailing blank rows a screen has BY SHAPE: a fresh 81-row
  run half-printed produced a console full of blanks with a scrollbar the reader measured
  scrolling through before any output filled it.
- **The console stays where the reader scrolled it, and the texts speak one language.** A reader
  who scrolled up in a PTY console was dragged back to the bottom by the next poll, because the
  scrollbox pinned itself unconditionally. The pin is now a decision (`scroll-keeper.ts`): it holds
  only while the reader is at the bottom, releases while they are away - the view keeps its rows -
  and resumes when they return. A fresh selection arms it, so a session the reader has not read
  starts at its bottom like any screen they never scrolled. The host's own transcript is the
  reference for the same rule. The run timer reads `endedAt` where a record has no `exitAt`, which
  is what a 19-second build needed to stop claiming it had run 17 hours. And the session panel's
  German leftovers (`N Sessionen… (aufklappen)`, `… und N weitere in der Sidebar`) are English,
  like the sidebar next to them already was.
- **The send dialog survived the gesture that opened it, and grew the keys it was missing.** The
  dialog asked for on the panel header's mouse-down was dead on arrival: a click delivers a
  mouse-down and a mouse-up, and by release time the host's dialog backdrop sat under the pointer,
  whose mouse-up closes the dialog - so the field only stayed open while the button was held.
  Reported by a reader, reproduced from the host's own backdrop handler
  (`packages/tui/src/ui/dialog.tsx` in the opencode checkout). The opener now fires on mouse-up -
  mousedown-only stays for the togglers, and a one-shot open belongs to the release. The dialog
  itself is now the plugin's own rather than the SDK prompt, because the SDK one draws only a title
  and a field: it has a `✕ close` the pointer can click, `enter submit · esc close` for the
  keyboard, and a row of key chips (`Ctrl+C`, `Ctrl+D`, `Ctrl+Z`, `Esc`, `Tab`, `Enter`) that send
  their control byte at once, without the typed line - `writeInput` posts bytes, so the chips are
  data, and the ending key is data the line discipline reads as enter. The dialog settles once and
  closes after, so a dismissal and a submission cannot interleave; the action keeps a blank-line
  guard at the seam because a whitespace answer is neither a key nor a command.

- **A row clicked in the sidebar now shows that process, even when its conversation is another
  project's.** The sidebar lists PTYs from every project, while a panel belongs to ONE session and
  listed only that session's processes - so a row whose conversation this project has never opened
  showed nothing, in every tab. Measured: seven `Lizenz-Hashes erzeugen` runs whose parent was a
  davx5 conversation from the day before, listed by the sidebar and by no panel at all. A click now
  scopes the panel to the conversation the row names - the parent id needs no session to exist, it is
  the key the PTY was recorded under - and the line above the console says which process is on
  screen: title, date, state, and the conversation that started it, falling back to the parent id
  when the host cannot name it. Opening the panel from the palette clears that scope, so it means
  this conversation again.
- **Sidebar rows and group headings wrapped in a narrow sidebar, splitting a group in two.** At ~36
  columns chevron (2) + title (22) + meta (18) came to 42, and a text wraps by default: the heading
  drew over two lines. The title is now the element that shrinks and never wraps, the state and the
  controls are fixed, and the state is its own element rather than the tail of one string - a row cut
  from its end lost `123456L` to `1` below 30 columns. (Committed one commit before this entry was
  written; the code and its tests are in `bd2095e`.)
- **The sidebar asks the server half where it is listening, instead of deriving it.** The origin
  record is filed under the location the server was STARTED for, and one long-lived
  `opencode serve --service` makes that unknowable: it hosts the plugin for every project the
  user opens, so the record sits under the directory that process was started in while the panel
  sits in a session somewhere else. Measured while chasing it - the record said `/var/home/j`
  while the panel was in `.../homelab/openwrt-installer-lab`, with 376 sessions (48 of them
  failed) behind a server that answered `/health`, and the panel read "not running". A plugin can
  register an RPC method its TUI half calls (`@opencode/plugin/rpc`, `context.client.rpc`), so
  this plugin now answers one question - where is the server - read off the live server object.
  That needs no key and cannot be stale. The record is still tried next, since that is what a host
  without RPC has, and a panel that can name neither still takes any healthy record, logged,
  because a list from another instance beats no list at all. Starting a server stays where it was:
  only a user who expanded the panel causes one.
- **A sidebar store written before a field existed took the whole section down.** The host's
  `store` persists an object and hands it back exactly as it was: `initial` is used only when
  nothing was stored, and is never merged into what comes back. So every preference added after
  a reader's first run is `undefined` until something writes it - and `filter` was read as a
  string, reached `normalizeQuery`, and threw `undefined is not an object (evaluating
  'query.trim')` inside the `sidebar.content` slot on every render, which is why dismissing the
  crash panel brought it straight back. The preferences are now repaired once per setup
  (`fillMissingPrefs`), which also replaces a stored value of the wrong type, and covers
  `collapsedGroups` from the same kind of store.
- **The sidebar reported "not running" next to a healthy server, so its footer stayed empty.**
  A PTY server files ONE origin record, under the location it was STARTED for, while the host
  hands a plugin the SESSION's location (`packages/tui/src/routes/session/index.tsx` sets it
  from `session().location`). A server that `autostart` started is filed under the app's default
  location, so as soon as a session was moved - `/cd`, or opencode launched in one directory
  with a session in a project below it - the two keys differed: the lookup matched records on
  the directory exactly, found nothing, and the panel drew "not running" with no sessions. The
  footer only draws when there is something to report, which is why it vanished with it.
  Measured on a running 2.0.29: `findProjectOrigin("/var/home/j")` answered
  `http://127.0.0.1:4200` while the panel's own key returned null, with 376 sessions
  (48 of them failed - the footer said nothing) behind it. The panel now tries the session's
  location first and the app's default second, so a moved session still reads its own project's
  server rather than another one.

## [0.5.1] - 2026-10-05

### Fixed

- The published tarball referenced a patch file it did not contain, so
  `bun install` in the extracted package failed. `patches/` is now part of the
  published files.

## [0.5.0] - 2026-10-04

The release that brings the web UI to parity with the tools, and makes the tools
say what they actually did.

### Added

**Tools**

- `pty_screen` returns the rendered screen rather than the byte stream, so a TUI
  can be read as a TUI instead of as escape sequences.
- `pty_wait` blocks until a session exits or produces matching output.
- Every session is given a terminal size at spawn, and `pty_resize` lets the
  agent change it. A program that formats for 80 columns and is given 40 wraps in
  the wrong places, and nothing in the output says why.
- Sessions are archived to disk and readable after a restart. A restart is
  announced, and a session that exists only in the archive is labelled as such
  rather than looking like a live one.
- The usage guide ships as an embedded skill, so an agent is told how to drive
  the tools when it needs to.

**Web UI**

- Documentation dialog, split for humans and for LLMs. The LLM half is the same
  document the plugin hands the agent, so both read one source.
- Settings for theme, terminal font size and a debug bar.
- Session search, matching the parent OpenCode session as well as the process.
- PTYs grouped by the OpenCode session that created them.
- Download a transcript as text, with or without control characters.
- Bulk removal with undo. Finished sessions move to the trash and come back;
  running sessions are stopped, and the confirmation names both numbers, because
  they are not the same kind of action.
- Version and Git commit of the build that is actually running.

**Terminal**

- The terminal renders through ghostty-web: a full palette, adaptive light and
  dark themes, bounded colour queries, mouse reporting, and copyable output
  without a canvas selection.

### Changed

- `pty_read` no longer clamps lines silently. It applies a disclosed budget and
  tells you what it cut, with a cursor to continue from, so a truncated read can
  no longer be mistaken for the end of the buffer.
- Every result tag carries `id="..."` as an attribute. Four of the nine tags only
  mentioned the id in prose, and a model that learned the convention from the
  others looked for an attribute that was not there.
- Exit notifications are observable and say so when they cannot be delivered,
  instead of failing quietly.
- The web UI holds one WebSocket connection and no longer polls.
- Tool descriptions say which tool answers a question, rather than describing
  the whole surface.

### Fixed

- A command that cannot be executed is refused before the spawn. It used to start,
  then abort inside the PTY helper, which surfaced as a plugin crash and left the
  session reporting `running` after the process was gone.
- `pty_screen` reports the wrap on the row that continues rather than the row that
  ran out.
- Terminal size is resolved once at spawn and recorded, instead of being
  re-derived at each use and ending up reporting a size it is not running at.
- The V2 plugin survives a single failed registration step instead of losing the
  whole plugin, and its notifications carry a message id the host accepts.
- The web server falls back to a free port when the preferred one is taken, and no
  longer hard-caches the HTML shell.
- Terminal streaming is gap-free across a snapshot and the delta stream that
  follows it, and the grid stays fitted to its pane.
- ghostty-web: reset handlers stay live, resolved black backgrounds render, and a
  terminal reset no longer loses the selection.
- Builds stamp their identity into `dist/` rather than the source tree, so a build
  no longer leaves the working tree dirty.

### Security

- Socket.dev scans every push, not only a local machine, and the local quality gate
  fails on a finding.
- A high-severity advisory in a transitive dependency of the OpenCode plugin SDK
  is resolved.
- Exit-notification delivery failures are logged rather than swallowed.

[Unreleased]: https://github.com/lenucksi/opencode-pty/compare/v0.7.1...HEAD
[0.7.1]: https://github.com/lenucksi/opencode-pty/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/lenucksi/opencode-pty/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/lenucksi/opencode-pty/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/lenucksi/opencode-pty/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/lenucksi/opencode-pty/compare/v0.4.0...v0.5.0