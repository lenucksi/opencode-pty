/**
 * How many terminal cells a string occupies, and how to cut it at a cell boundary.
 *
 * The panel shows a session's screen in a sidebar that is a fraction of the width
 * the program was started with, so the console has to be scrollable sideways. The
 * scroll offset is measured in CELLS, because that is what the reader sees, while
 * the text is a sequence of characters and a double-width character covers two.
 *
 * The ranges below are the ones a terminal actually renders double-width: the CJK
 * and Hangul blocks, the fullwidth forms, and the emoji that are not narrow. A
 * character outside them counts as one cell. This is an approximation of what the
 * terminal draws, not a copy of its tables - a character this counts wrongly shifts
 * the scrollbar by one cell, and the text itself stays intact.
 */

/** Code point ranges that occupy two cells. */
const WIDE_RANGES: readonly [number, number][] = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2e80, 0x303e], // CJK radicals, Kangxi
  [0x3041, 0x33ff], // Hiragana .. CJK compatibility
  [0x3400, 0x4dbf], // CJK extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xa000, 0xa4cf], // Yi
  [0xa960, 0xa97f], // Hangul Jamo extended-A
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe10, 0xfe19], // vertical forms
  [0xfe30, 0xfe6f], // CJK compatibility forms
  [0xff00, 0xff60], // fullwidth forms
  [0xffe0, 0xffe6], // fullwidth signs
  [0x1f300, 0x1f64f], // emoji: symbols and pictographs
  [0x1f900, 0x1f9ff], // supplemental symbols
  [0x20000, 0x3fffd], // CJK extension B and beyond
]

function isWide(codePoint: number): boolean {
  for (const [start, end] of WIDE_RANGES) {
    if (codePoint >= start && codePoint <= end) return true
  }
  return false
}

/** The cells a string occupies. */
export function cellWidth(text: string): number {
  let width = 0
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0
    width += isWide(codePoint) ? 2 : 1
  }
  return width
}

/**
 * The characters of `text` that start at or after cell `from` and end before cell
 * `to`.
 *
 * A double-width character that straddles the boundary is kept whole rather than cut
 * in half: a half character is a broken glyph, and the reader would rather see one
 * column too much than a rune cut in two.
 */
export function sliceCells(text: string, from: number, to: number): string {
  if (from <= 0 && to >= cellWidth(text)) return text
  let cell = 0
  let out = ''
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0
    const width = isWide(codePoint) ? 2 : 1
    const start = cell
    const end = cell + width
    cell = end
    if (end <= from) continue
    if (start >= to) break
    out += character
  }
  return out
}
