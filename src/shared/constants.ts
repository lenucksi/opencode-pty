// Shared constants used across the entire application
export const DEFAULT_READ_LIMIT = 500
export const DEFAULT_MAX_BUFFER_LINES = 50000

// Performance monitoring constants
export const PERFORMANCE_MEASURE_LIMIT = 100

/**
 * Deliberately conservative characters-per-token ratio used to turn a token
 * budget into a character budget. Terminal output is code and ANSI escapes,
 * which tokenize worse than prose, so under-estimating the cost keeps a result
 * inside the window it was sized for.
 */
export const CHARS_PER_TOKEN = 4

/**
 * Default cap for a single `pty_read` result, in tokens.
 *
 * Replaces the old per-line `MAX_LINE_LENGTH` clamp. That clamp bounded nothing:
 * `DEFAULT_READ_LIMIT` (500) x 2000 equals `PTY_MAX_BUFFER_SIZE` (1,000,000),
 * so a full-buffer result was possible with it in place. A cap on the whole
 * result is the quantity that actually has to be bounded.
 */
export const DEFAULT_READ_MAX_TOKENS = 25_000

/** Hard ceiling for one result. A caller may ask for more, never beyond this. */
export const MAX_READ_MAX_TOKENS = 125_000

/** Environment overrides, so a host can widen or narrow the budget. */
export const READ_MAX_TOKENS_ENV = 'PTY_READ_MAX_TOKENS'
export const READ_MAX_TOKENS_CEILING_ENV = 'PTY_READ_MAX_TOKENS_CEILING'

/** Parse a positive integer env override, falling back when absent or invalid. */
export function readTokenBudget(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
  fallback: number
): number {
  const raw = env[key]
  if (raw === undefined) return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return parsed
}

/** Character budget for a token budget. */
export function charsForTokens(tokens: number): number {
  return Math.max(1, Math.floor(tokens * CHARS_PER_TOKEN))
}
