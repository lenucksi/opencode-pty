/**
 * Freshness pins must be narrow and must expire.
 *
 * A pin is a decision that the host, not this package, chooses the version. That is
 * legitimate only while the host really is on that version; the expiry is what forces
 * somebody to look again instead of letting a pin become permanent by neglect.
 */

import { describe, expect, it } from 'bun:test'

import {
  activeFreshnessPins,
  excusePinnedDependencies,
  TEMPORARY_FRESHNESS_PINS,
} from '../scripts/quality/dependencies.ts'

const coreRow = '| @opentui/core (dev)   | 0.8.4   | 0.8.4  | 0.9.2  |'
const solidRow = '| @opentui/solid (peer) | 0.8.4   | 0.9.2  | 0.9.2  |'
const otherRow = '| vite (dev)           | 8.3.5   | 8.3.5  | 8.3.8  |'

describe('temporary freshness pins', () => {
  it('holds only the named packages while the window is open', () => {
    const held = activeFreshnessPins(new Date('2026-11-17T12:00:00Z'))
    for (const entry of TEMPORARY_FRESHNESS_PINS) {
      for (const name of entry.names) expect(held).toContain(name)
    }
    expect(excusePinnedDependencies([coreRow, solidRow, otherRow], held)).toEqual([otherRow])
  })

  it('expires on the stated day and lets the gate fail again', () => {
    const held = activeFreshnessPins(new Date('2026-12-15T00:00:00Z'))
    expect(held).toEqual([])
    expect(excusePinnedDependencies([coreRow, solidRow, otherRow], held)).toHaveLength(3)
  })

  it('carries a reason, a pinned version and an expiry for every entry', () => {
    for (const entry of TEMPORARY_FRESHNESS_PINS) {
      expect(entry.names.length).toBeGreaterThan(0)
      expect(entry.version).not.toBe('')
      expect(entry.reason.length).toBeGreaterThan(40)
      expect(entry.expires).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })
})
