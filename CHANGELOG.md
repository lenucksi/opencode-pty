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