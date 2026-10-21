import { describe, expect, it } from 'bun:test'

import { cellWidth, sliceCells } from '../src/tui/cell-width.ts'

describe('cellWidth', () => {
  it('counts an ASCII string one cell per character', () => {
    expect(cellWidth('hello')).toBe(5)
    expect(cellWidth('')).toBe(0)
  })

  it('counts a double-width character as two cells', () => {
    expect(cellWidth('日本語')).toBe(6)
    expect(cellWidth('a日')).toBe(3)
  })

  it('counts an emoji as two cells', () => {
    expect(cellWidth('😀')).toBe(2)
  })
})

describe('sliceCells', () => {
  it('returns the whole string when the window covers it', () => {
    expect(sliceCells('hello', 0, 10)).toBe('hello')
  })

  it('cuts at the window', () => {
    expect(sliceCells('hello', 1, 3)).toBe('el')
  })

  it('keeps a double-width character whole rather than cutting it in half', () => {
    // The window starts in the middle of the wide character: showing it whole costs
    // one column, showing half of it is a broken glyph.
    expect(sliceCells('a日b', 2, 4)).toBe('日b')
  })

  it('skips what lies before the window', () => {
    expect(sliceCells('a日b', 3, 4)).toBe('b')
  })

  it('stops at the end of the window', () => {
    expect(sliceCells('abcdef', 0, 3)).toBe('abc')
  })

  it('returns nothing for a window past the end', () => {
    expect(sliceCells('abc', 10, 20)).toBe('')
  })
})
