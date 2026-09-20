import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'

import {
  type PreferenceStorage,
  THEME_ATTRIBUTE,
  THEME_STORAGE_KEY,
  type ThemeRoot,
  applyScheme,
  initTheme,
  parsePreference,
  readStoredPreference,
  resolveScheme,
  storePreference,
  themeFromStyles,
} from '../src/web/client/lib/theme.ts'

const ANSI_NAMES = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const

function fakeRoot(): ThemeRoot & { attributes: Map<string, string> } {
  const attributes = new Map<string, string>()
  return {
    attributes,
    setAttribute(name, value) {
      attributes.set(name, value)
    },
  }
}

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

describe('themeFromStyles', () => {
  it('maps the pane and ANSI tokens into an emulator palette', () => {
    const tokens: Record<string, string> = {
      '--term-bg': '#0d1117',
      '--term-fg': '#c9d1d9',
      '--term-cursor': '#c9d1d9',
      '--term-cursor-accent': '#0d1117',
      '--term-selection-bg': '#264f78',
      '--term-selection-fg': '#e6edf3',
    }
    const expectedAnsi: Record<string, string> = {}
    ANSI_NAMES.forEach((name, index) => {
      const color = `#00000${index.toString(16)}`
      tokens[`--term-ansi-${index}`] = color
      expectedAnsi[name] = color
    })

    const theme = themeFromStyles((property) => tokens[property] ?? '')

    expect(theme).toEqual({
      background: '#0d1117',
      foreground: '#c9d1d9',
      cursor: '#c9d1d9',
      cursorAccent: '#0d1117',
      selectionBackground: '#264f78',
      selectionForeground: '#e6edf3',
      ...expectedAnsi,
    })
  })

  it('omits undefined tokens so the emulator keeps its own defaults', () => {
    expect(themeFromStyles(() => '')).toEqual({})
    expect(themeFromStyles((property) => (property === '--term-bg' ? '#000000' : ''))).toEqual({
      background: '#000000',
    })
  })
})

describe('parsePreference', () => {
  it('accepts the two explicit schemes', () => {
    expect(parsePreference('light')).toBe('light')
    expect(parsePreference('dark')).toBe('dark')
  })

  it('falls back to auto for anything else', () => {
    expect(parsePreference('auto')).toBe('auto')
    expect(parsePreference('')).toBe('auto')
    expect(parsePreference('solarized')).toBe('auto')
    expect(parsePreference(null)).toBe('auto')
    expect(parsePreference(undefined)).toBe('auto')
  })
})

describe('resolveScheme', () => {
  it('follows the system while the preference is auto', () => {
    expect(resolveScheme('auto', true)).toBe('light')
    expect(resolveScheme('auto', false)).toBe('dark')
  })

  it('lets an explicit preference win over the system', () => {
    expect(resolveScheme('light', false)).toBe('light')
    expect(resolveScheme('dark', true)).toBe('dark')
  })
})

describe('readStoredPreference', () => {
  it('reads a stored preference', () => {
    expect(readStoredPreference(fakeStorage({ [THEME_STORAGE_KEY]: 'light' }))).toBe('light')
  })

  it('defaults to auto for missing, unknown or unreadable values', () => {
    expect(readStoredPreference(fakeStorage())).toBe('auto')
    expect(readStoredPreference(fakeStorage({ [THEME_STORAGE_KEY]: 'nonsense' }))).toBe('auto')
    expect(readStoredPreference(null)).toBe('auto')
    expect(readStoredPreference(undefined)).toBe('auto')
    expect(readStoredPreference(throwingStorage())).toBe('auto')
  })
})

describe('storePreference', () => {
  it('persists under the theme key', () => {
    const storage = fakeStorage()
    storePreference(storage, 'dark')
    expect(storage.values.get(THEME_STORAGE_KEY)).toBe('dark')
  })

  it('is a no-op without storage and tolerates a throwing one', () => {
    expect(() => storePreference(null, 'light')).not.toThrow()
    expect(() => storePreference(throwingStorage(), 'light')).not.toThrow()
  })
})

describe('applyScheme', () => {
  it('sets the theme attribute on the root element', () => {
    const root = fakeRoot()
    applyScheme(root, 'light')
    expect(root.attributes.get(THEME_ATTRIBUTE)).toBe('light')
  })
})

describe('initTheme', () => {
  it('follows the system when the preference is auto', () => {
    const root = fakeRoot()
    const result = initTheme({ root, storage: fakeStorage(), prefersLight: true })

    expect(result).toEqual({ preference: 'auto', scheme: 'light' })
    expect(root.attributes.get(THEME_ATTRIBUTE)).toBe('light')
  })

  it('applies a stored preference regardless of the system', () => {
    const root = fakeRoot()
    const result = initTheme({
      root,
      storage: fakeStorage({ [THEME_STORAGE_KEY]: 'dark' }),
      prefersLight: true,
    })

    expect(result).toEqual({ preference: 'dark', scheme: 'dark' })
    expect(root.attributes.get(THEME_ATTRIBUTE)).toBe('dark')
  })

  it('defaults to dark when neither storage nor the media query is available', () => {
    const root = fakeRoot()
    const result = initTheme({ root, storage: null, prefersLight: false })

    expect(result).toEqual({ preference: 'auto', scheme: 'dark' })
    expect(root.attributes.get(THEME_ATTRIBUTE)).toBe('dark')
  })

  it('survives unreadable storage', () => {
    const root = fakeRoot()
    const result = initTheme({ root, storage: throwingStorage(), prefersLight: true })

    expect(result).toEqual({ preference: 'auto', scheme: 'light' })
  })
})

// The emulator palette lives in CSS, so the readability of the terminal is a
// property of the stylesheet. These checks parse the real tokens and enforce a
// WCAG contrast budget; the bug this guards against was dark shades (`#000000`
// black, muted bright colors) that were invisible on the pane background.
describe('index.css terminal palette', () => {
  const css = readFileSync(new URL('../src/web/client/index.css', import.meta.url), 'utf8')

  function tokensFor(selector: string): Record<string, string> {
    const start = css.indexOf(`${selector} {`)
    expect(start, `missing ${selector}`).toBeGreaterThanOrEqual(0)
    const end = css.indexOf('}', start)
    const block = css.slice(start, end)
    const tokens: Record<string, string> = {}
    for (const match of block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\b/g)) {
      const [, name, value] = match
      if (name && value) {
        tokens[name] = value
      }
    }
    return tokens
  }

  function luminance(hex: string): number {
    const channels = [1, 3, 5].map((offset) => {
      const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255
      return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    })
    const [r, g, b] = channels as [number, number, number]
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }

  function contrastRatio(a: string, b: string): number {
    const [bright, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
    return (bright + 0.05) / (dark + 0.05)
  }

  for (const [scheme, selector] of [
    ['dark', ':root'],
    ['light', ':root[data-theme="light"]'],
  ] as const) {
    it(`${scheme}: keeps default text at a AAA contrast ratio`, () => {
      const tokens = tokensFor(selector)
      const bg = tokens['term-bg']
      const fg = tokens['term-fg']
      expect(bg).toBeDefined()
      expect(fg).toBeDefined()
      expect(contrastRatio(fg as string, bg as string)).toBeGreaterThanOrEqual(7)
    })

    it(`${scheme}: keeps every ANSI colour readable on the pane background`, () => {
      const tokens = tokensFor(selector)
      const bg = tokens['term-bg'] as string
      const failures: string[] = []

      ANSI_NAMES.forEach((name, index) => {
        const color = tokens[`term-ansi-${index}`]
        if (!color) {
          failures.push(`--term-ansi-${index} (${name}) is missing`)
          return
        }
        const ratio = contrastRatio(color, bg)
        if (ratio < 4) {
          failures.push(`--term-ansi-${index} (${name}) ${color} on ${bg} = ${ratio.toFixed(2)}:1`)
        }
      })

      expect(failures).toEqual([])
    })
  }
})
