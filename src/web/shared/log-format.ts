/** How a session transcript is rendered for a download or the log endpoint. */
export type LogFormat = 'plain' | 'raw'

/** Anything unknown means "readable text". */
export function parseLogFormat(value: string | null | undefined): LogFormat {
  return value === 'raw' ? 'raw' : 'plain'
}

/**
 * `plain` strips ANSI escape sequences and turns CRLF into LF so the file reads
 * like normal text; `raw` keeps every control character exactly as the process
 * emitted it (useful for tools and for debugging colour handling).
 */
export function normalizeLogText(raw: string, format: LogFormat): string {
  if (format === 'raw') return raw
  return stripAnsi(raw).replaceAll('\r\n', '\n').replaceAll('\r', '\n')
}

function stripAnsi(text: string): string {
  return typeof Bun !== 'undefined' && typeof Bun.stripANSI === 'function'
    ? Bun.stripANSI(text)
    : text
}

/** `x.txt` for readable text, `x.log` for the version that keeps escapes. */
export function logFileName(id: string, format: LogFormat): string {
  return `${id}.${format === 'raw' ? 'log' : 'txt'}`
}
