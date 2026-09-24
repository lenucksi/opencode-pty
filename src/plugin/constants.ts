// Shared constants for the PTY plugin

// PTY terminal and UI constants
export const DEFAULT_TERMINAL_COLS = 120
export const DEFAULT_TERMINAL_ROWS = 40
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
