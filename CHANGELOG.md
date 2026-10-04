# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/lenucksi/opencode-pty/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/lenucksi/opencode-pty/compare/v0.4.0...v0.5.0