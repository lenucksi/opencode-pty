import { describe, expect, it } from 'bun:test'

import type { PreferenceStorage } from '../src/web/client/lib/theme.ts'
import {
  DEFAULT_SHOW_DEBUG_BAR,
  DEFAULT_TERMINAL_FONT_SIZE,
  DEFAULT_UI_PREFS,
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  UI_PREFS_STORAGE_KEY,
  clampFontSize,
  parseUiPrefs,
  readUiPrefs,
  storeUiPrefs,
  type UiPrefs,
} from '../src/web/client/lib/ui-prefs.ts'

function fakeStorage(initial: Record<string, string> = {}): PreferenceStorage & {
  values: Map<string, string>
} {
  const values = new Map(Object.entries(initial))
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value)
    },
  }
}

function throwingStorage(): PreferenceStorage {
  return {
    getItem: () => {
      throw new Error('blocked')
    },
    setItem: () => {
      throw new Error('blocked')
    },
  }
}

describe('clampFontSize', () => {
  it('keeps values inside the supported range', () => {
    expect(clampFontSize(MIN_TERMINAL_FONT_SIZE)).toBe(MIN_TERMINAL_FONT_SIZE)
    expect(clampFontSize(MAX_TERMINAL_FONT_SIZE)).toBe(MAX_TERMINAL_FONT_SIZE)
    expect(clampFontSize(18)).toBe(18)
  })

  it('clamps values below and above the range', () => {
    expect(clampFontSize(1)).toBe(MIN_TERMINAL_FONT_SIZE)
    expect(clampFontSize(0)).toBe(MIN_TERMINAL_FONT_SIZE)
    expect(clampFontSize(-20)).toBe(MIN_TERMINAL_FONT_SIZE)
    expect(clampFontSize(100)).toBe(MAX_TERMINAL_FONT_SIZE)
  })

  it('rounds fractional sizes to whole pixels', () => {
    expect(clampFontSize(14.4)).toBe(14)
    expect(clampFontSize(14.6)).toBe(15)
  })

  it('falls back to the default for non-finite values', () => {
    expect(clampFontSize(Number.NaN)).toBe(DEFAULT_TERMINAL_FONT_SIZE)
    expect(clampFontSize(Number.POSITIVE_INFINITY)).toBe(DEFAULT_TERMINAL_FONT_SIZE)
    expect(clampFontSize(Number.NEGATIVE_INFINITY)).toBe(DEFAULT_TERMINAL_FONT_SIZE)
  })
})

describe('parseUiPrefs', () => {
  it('returns the defaults for missing or empty input', () => {
    expect(parseUiPrefs(null)).toEqual(DEFAULT_UI_PREFS)
    expect(parseUiPrefs(undefined)).toEqual(DEFAULT_UI_PREFS)
    expect(parseUiPrefs('')).toEqual(DEFAULT_UI_PREFS)
  })

  it('returns the defaults for corrupt JSON', () => {
    expect(parseUiPrefs('{not json')).toEqual(DEFAULT_UI_PREFS)
    expect(parseUiPrefs('null')).toEqual(DEFAULT_UI_PREFS)
    expect(parseUiPrefs('42')).toEqual(DEFAULT_UI_PREFS)
    expect(parseUiPrefs('"dark"')).toEqual(DEFAULT_UI_PREFS)
    expect(parseUiPrefs('[]')).toEqual(DEFAULT_UI_PREFS)
  })

  it('reads a complete stored object', () => {
    const stored: UiPrefs = { terminalFontSize: 20, showDebugBar: false }
    expect(parseUiPrefs(JSON.stringify(stored))).toEqual(stored)
  })

  it('fills in defaults for missing fields', () => {
    expect(parseUiPrefs('{}')).toEqual(DEFAULT_UI_PREFS)
    expect(parseUiPrefs('{"terminalFontSize":18}')).toEqual({
      terminalFontSize: 18,
      showDebugBar: DEFAULT_SHOW_DEBUG_BAR,
    })
    expect(parseUiPrefs('{"showDebugBar":false}')).toEqual({
      terminalFontSize: DEFAULT_TERMINAL_FONT_SIZE,
      showDebugBar: false,
    })
  })

  it('clamps and ignores malformed fields without discarding the valid ones', () => {
    expect(parseUiPrefs('{"terminalFontSize":99,"showDebugBar":false}')).toEqual({
      terminalFontSize: MAX_TERMINAL_FONT_SIZE,
      showDebugBar: false,
    })
    expect(parseUiPrefs('{"terminalFontSize":"large","showDebugBar":"yes"}')).toEqual(
      DEFAULT_UI_PREFS
    )
    expect(parseUiPrefs('{"terminalFontSize":null,"showDebugBar":false}')).toEqual({
      terminalFontSize: DEFAULT_TERMINAL_FONT_SIZE,
      showDebugBar: false,
    })
  })
})

describe('readUiPrefs', () => {
  it('reads the stored preferences', () => {
    const storage = fakeStorage({
      [UI_PREFS_STORAGE_KEY]: JSON.stringify({ terminalFontSize: 16, showDebugBar: false }),
    })
    expect(readUiPrefs(storage)).toEqual({ terminalFontSize: 16, showDebugBar: false })
  })

  it('returns the defaults when the key is absent', () => {
    expect(readUiPrefs(fakeStorage())).toEqual(DEFAULT_UI_PREFS)
  })

  it('returns the defaults for corrupt stored values', () => {
    expect(readUiPrefs(fakeStorage({ [UI_PREFS_STORAGE_KEY]: 'not json' }))).toEqual(
      DEFAULT_UI_PREFS
    )
  })

  it('tolerates unavailable storage', () => {
    expect(readUiPrefs(null)).toEqual(DEFAULT_UI_PREFS)
    expect(readUiPrefs(undefined)).toEqual(DEFAULT_UI_PREFS)
    expect(readUiPrefs(throwingStorage())).toEqual(DEFAULT_UI_PREFS)
  })
})

describe('storeUiPrefs', () => {
  it('round-trips through storage under the prefs key', () => {
    const storage = fakeStorage()
    storeUiPrefs(storage, { terminalFontSize: 22, showDebugBar: false })

    expect(readUiPrefs(storage)).toEqual({ terminalFontSize: 22, showDebugBar: false })
    expect(storage.values.has(UI_PREFS_STORAGE_KEY)).toBe(true)
  })

  it('clamps the font size before writing', () => {
    const storage = fakeStorage()
    storeUiPrefs(storage, { terminalFontSize: 99, showDebugBar: true })

    expect(readUiPrefs(storage).terminalFontSize).toBe(MAX_TERMINAL_FONT_SIZE)
  })

  it('is a no-op without storage and tolerates a throwing one', () => {
    expect(() => storeUiPrefs(null, DEFAULT_UI_PREFS)).not.toThrow()
    expect(() => storeUiPrefs(undefined, DEFAULT_UI_PREFS)).not.toThrow()
    expect(() => storeUiPrefs(throwingStorage(), DEFAULT_UI_PREFS)).not.toThrow()
  })
})
