/**
 * Resolve the part of a terminal buffer that is currently on screen.
 *
 * Buffer coordinates include the scrollback, and the emulator's `viewportY`
 * counts lines scrolled up from the bottom, so the first visible line is
 * `bufferLength - rows - viewportY`.
 */
export function visibleScreenRange(
  bufferLength: number,
  rows: number,
  viewportY: number
): { start: number; end: number } {
  const visibleRows = Math.max(0, Math.min(rows, bufferLength))
  const bottom = bufferLength - visibleRows
  const start = Math.max(0, bottom - Math.max(0, viewportY))

  return { start, end: start + visibleRows - 1 }
}

/**
 * Join lines into clipboard text, dropping the empty lines the emulator keeps
 * below the last printed row (a screen is always `rows` tall).
 */
export function linesToText(lines: string[]): string {
  let end = lines.length
  while (end > 0 && (lines[end - 1] ?? '').trim() === '') {
    end--
  }
  return lines.slice(0, end).join('\n')
}
