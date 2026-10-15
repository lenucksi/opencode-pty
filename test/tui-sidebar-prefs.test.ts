import { describe, expect, it } from 'bun:test'

import {
  fillMissingPrefs,
  initialSidebarPrefs,
  type SidebarPrefs,
  setFilter,
  toggleGroup,
} from '../src/tui/sidebar-prefs.ts'

/**
 * The durable preferences, and the two things that bite about them.
 *
 * The interesting case is a store from an older build: the host hands back exactly what was
 * persisted and never merges `initial` into it, so a field added later is MISSING rather than
 * defaulted - and reading one is a crash, not a `false`.
 */

describe('fillMissingPrefs', () => {
  it('fills in what a store from an older build left out', () => {
    const older: Partial<SidebarPrefs> = { collapsed: false, showFinished: true }
    fillMissingPrefs(older)
    expect(older).toEqual({
      collapsed: false,
      showFinished: true,
      collapsedGroups: [],
      filter: '',
    })
  })

  // A value of the WRONG type is as unusable as a missing one, and the persisted JSON is a
  // boundary nothing validates: `collapsedGroups` as a string would throw on `.includes`, and a
  // non-string `filter` is exactly the `.trim()` that took the slot down.
  it('replaces a value of the wrong type rather than trusting it', () => {
    const junk = {
      collapsed: 'yes',
      showFinished: 1,
      collapsedGroups: 'ses_a',
      filter: 42,
    } as unknown as Partial<SidebarPrefs>
    fillMissingPrefs(junk)
    expect(junk).toEqual(initialSidebarPrefs())
  })

  // What IS there has to survive: a repair that reset the fold and the query would silently
  // throw away the reader's panel on every setup.
  it('leaves the values it can use alone', () => {
    const prefs: SidebarPrefs = {
      ...initialSidebarPrefs(),
      collapsedGroups: ['ses_a'],
      filter: 'build',
    }
    fillMissingPrefs(prefs)
    expect(prefs.collapsedGroups).toEqual(['ses_a'])
    expect(prefs.filter).toBe('build')
  })

  it('is a no-op on a complete store', () => {
    const prefs = initialSidebarPrefs()
    const before = JSON.stringify(prefs)
    fillMissingPrefs(prefs)
    expect(JSON.stringify(prefs)).toBe(before)
  })
})

describe('toggleGroup', () => {
  it('adds an absent key and removes a present one', () => {
    const prefs = initialSidebarPrefs()
    toggleGroup(prefs, 'ses_a')
    expect(prefs.collapsedGroups).toEqual(['ses_a'])
    toggleGroup(prefs, 'ses_a')
    expect(prefs.collapsedGroups).toEqual([])
  })

  it('leaves the other keys alone', () => {
    const prefs: SidebarPrefs = {
      ...initialSidebarPrefs(),
      collapsedGroups: ['ses_a', 'ses_b'],
    }
    toggleGroup(prefs, 'ses_a')
    expect(prefs.collapsedGroups).toEqual(['ses_b'])
  })
})

describe('setFilter', () => {
  it('replaces the query, and an empty string is how it is cleared', () => {
    const prefs = initialSidebarPrefs()
    setFilter(prefs, 'build')
    expect(prefs.filter).toBe('build')
    setFilter(prefs, '')
    expect(prefs.filter).toBe('')
  })
})
