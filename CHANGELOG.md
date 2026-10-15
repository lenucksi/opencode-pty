# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/lenucksi/opencode-pty/compare/v0.5.1...HEAD
[0.5.1]: https://github.com/lenucksi/opencode-pty/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/lenucksi/opencode-pty/compare/v0.4.0...v0.5.0