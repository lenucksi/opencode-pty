/**
 * The keys a terminal has, by the name a person would use for them.
 *
 * `pty_write` takes bytes, which means a model has to know that Enter is `\r` and
 * that ArrowUp is `\x1b[A` - and a byte it gets wrong is not an error, it is a
 * prompt that does not move. This map is the other way round: a name in, the bytes
 * out, and the tool reports the name back so a wrong key is visible in the
 * transcript.
 *
 * Pure and separate from the tool for the same reason `screen-style.ts` is: the
 * table is the interesting part, and a table is testable without a PTY.
 */

/** A key whose bytes are fixed. */
const KEYS: Readonly<Record<string, string>> = {
  enter: '\r',
  return: '\r',
  tab: '\t',
  escape: '\x1b',
  esc: '\x1b',
  backspace: '\x7f',
  bs: '\x7f',
  delete: '\x1b[3~',
  del: '\x1b[3~',
  insert: '\x1b[2~',
  ins: '\x1b[2~',
  space: ' ',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  home: '\x1b[H',
  end: '\x1b[F',
  pageup: '\x1b[5~',
  pgup: '\x1b[5~',
  pagedown: '\x1b[6~',
  pgdn: '\x1b[6~',
}

/** `F1`..`F12`, which are `ESC O P` for the first four and `ESC [ 15~`-style after. */
const FUNCTION_KEYS: Readonly<Record<number, string>> = {
  1: '\x1bOP',
  2: '\x1bOQ',
  3: '\x1bOR',
  4: '\x1bOS',
  5: '\x1b[15~',
  6: '\x1b[17~',
  7: '\x1b[18~',
  8: '\x1b[19~',
  9: '\x1b[20~',
  10: '\x1b[21~',
  11: '\x1b[23~',
  12: '\x1b[24~',
}

/** The most a single call may send, so one call cannot become a paste. */
export const MAX_KEY_TIMES = 100

/**
 * The bytes for one named key, or null when the name is not one of them.
 *
 * Accepted spellings: any case (`Enter`, `enter`, `ENTER`), `Ctrl-X`/`C-x`, `F1`
 * through `F12`. Control keys are the ASCII control bytes, which is what a terminal
 * sends for them: `C-c` is `\x03`, `C-d` is `\x04`, `C-space` is NUL.
 */
export function keySequence(key: string): string | null {
  const name = key.trim()
  if (name === '') return null

  const control = /^(?:ctrl-|c-)([a-z])$/i.exec(name)
  if (control?.[1]) return String.fromCharCode(control[1].toLowerCase().charCodeAt(0) - 96)
  if (/^(?:ctrl-|c-)space$/i.test(name)) return '\x00'

  const fn = /^f(\d{1,2})$/i.exec(name)
  if (fn?.[1]) return FUNCTION_KEYS[Number(fn[1])] ?? null

  return KEYS[name.toLowerCase()] ?? null
}

/** The names this build understands, for a "did you mean" line. */
export function knownKeyNames(): readonly string[] {
  return [
    'Enter',
    'Tab',
    'Escape',
    'Backspace',
    'Delete',
    'Space',
    'Up',
    'Down',
    'Left',
    'Right',
    'Home',
    'End',
    'PageUp',
    'PageDown',
    'Insert',
    'C-a',
    'C-c',
    'F1',
    'F12',
  ]
}
