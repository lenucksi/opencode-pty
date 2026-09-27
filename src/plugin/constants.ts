// Shared constants for the PTY plugin

// PTY terminal and UI constants
export const DEFAULT_TERMINAL_COLS = 120
export const DEFAULT_TERMINAL_ROWS = 40

/**
 * Size used when nothing better is known.
 *
 * A session spawned by the agent has no terminal attached, so there is no honest
 * "the size it would really run in". 120x40 is what the process used to get
 * unconditionally, and it is too small for anything that wraps a table or draws
 * a full-screen UI: those programs look broken rather than merely narrow, which
 * sends the reader looking for a bug that is not there.
 *
 * 240x80 is the conservative end of a modern terminal, chosen so that output
 * formatted for a wide screen stays on one line. `pty_spawn` accepts `cols` and
 * `rows`, and a size a connected web client has reported wins over this, so the
 * fallback only applies to headless spawns.
 */
export const FALLBACK_TERMINAL_COLS = 240
export const FALLBACK_TERMINAL_ROWS = 80
export const MIN_TERMINAL_COLS = 2
export const MIN_TERMINAL_ROWS = 1
export const MAX_TERMINAL_COLS = 1000
export const MAX_TERMINAL_ROWS = 1000
export const NOTIFICATION_LINE_TRUNCATE = 250
export const NOTIFICATION_TITLE_TRUNCATE = 64
/** Non-empty output lines appended to an exit notification, so the summary
 * (ansible's `PLAY RECAP`, a failing task, ...) reaches the model without a
 * follow-up `pty_read`. */
export const NOTIFICATION_TAIL_LINES = 8

/** Parent marker used when a PTY is created through the PTY web API itself. */
export const WEB_API_PARENT_SESSION_ID = 'web-api'
