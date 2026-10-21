/**
 * The sideways scrollbar's arithmetic.
 *
 * Pure on purpose: the numbers are the part that can be wrong quietly. A thumb one
 * cell off is a picture that still looks like a picture, so the geometry is checked
 * here rather than by looking at a frame.
 */

import { describe, expect, test } from 'bun:test'

import { scrollbarThumb } from '../src/tui/console-chrome.ts'

describe('scrollbarThumb', () => {
  test('starts at the left when nothing has been scrolled', () => {
    expect(scrollbarThumb(40, 0, 20, 200).start).toBe(0)
  })

  test('ends flush with the right when the last cell is on screen', () => {
    const { start, size } = scrollbarThumb(40, 180, 20, 200)
    expect(start + size).toBe(40)
  })

  test('is as wide as the share of the screen that is on view', () => {
    expect(scrollbarThumb(40, 0, 20, 200).size).toBe(4)
    expect(scrollbarThumb(40, 0, 100, 200).size).toBe(20)
  })

  test('moves with the offset', () => {
    const middle = scrollbarThumb(40, 90, 20, 200)
    const later = scrollbarThumb(40, 170, 20, 200)
    expect(middle.start).toBeGreaterThan(0)
    expect(later.start).toBeGreaterThan(middle.start)
  })

  test('keeps the thumb on the track when the offset runs past the end', () => {
    const { start, size } = scrollbarThumb(40, 999, 20, 200)
    expect(start + size).toBe(40)
    expect(start).toBeGreaterThan(0)
  })

  test('never disappears and never leaves the track', () => {
    expect(scrollbarThumb(40, 0, 1, 200).size).toBe(2)
    expect(scrollbarThumb(1, 0, 1, 200).size).toBe(1)
    expect(scrollbarThumb(0, 0, 1, 200).size).toBe(1)
  })
})
