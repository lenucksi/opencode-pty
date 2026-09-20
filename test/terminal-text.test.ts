import { describe, expect, it } from 'bun:test'

import { linesToText, visibleScreenRange } from '../src/web/client/lib/terminal-text.ts'

describe('visibleScreenRange', () => {
  it('takes the last screen worth of rows when the viewport is at the bottom', () => {
    // 100 scrollback lines + 24 screen rows; viewportY 0 means "at the bottom".
    expect(visibleScreenRange(124, 24, 0)).toEqual({ start: 100, end: 123 })
  })

  it('walks into the scrollback while scrolled up', () => {
    expect(visibleScreenRange(124, 24, 5)).toEqual({ start: 95, end: 118 })
  })

  it('clamps a scroll position beyond the available history', () => {
    expect(visibleScreenRange(124, 24, 999)).toEqual({ start: 0, end: 23 })
  })

  it('handles a buffer that is shorter than the screen', () => {
    expect(visibleScreenRange(10, 24, 0)).toEqual({ start: 0, end: 9 })
  })

  it('returns an empty range for an empty buffer', () => {
    expect(visibleScreenRange(0, 24, 0)).toEqual({ start: 0, end: -1 })
  })
})

describe('linesToText', () => {
  it('joins lines and drops the empty tail below the last printed row', () => {
    expect(linesToText(['first', 'second', '', '', ''])).toBe('first\nsecond')
  })

  it('keeps blank lines in the middle', () => {
    expect(linesToText(['first', '', 'third'])).toBe('first\n\nthird')
  })

  it('returns an empty string for a screen of blanks', () => {
    expect(linesToText(['', '   ', ''])).toBe('')
  })
})
