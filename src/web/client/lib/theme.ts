import type { ITheme } from 'ghostty-web'

/** Color schemes the app can render. */
export type ThemeScheme = 'dark' | 'light'

/** User-selectable preference: an explicit scheme or "follow the system". */
export type ThemePreference = 'auto' | ThemeScheme

export const THEME_STORAGE_KEY = 'opencode-pty-theme'

/** Attribute on `<html>` that selects the active token set in `index.css`. */
export const THEME_ATTRIBUTE = 'data-theme'

/** ANSI slots 0-15 in palette order; the array index is the ANSI color index. */
const ANSI_COLORS = [
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
] as const satisfies readonly (keyof ITheme)[]

type StyleLookup = (property: string) => string

/** Minimal storage surface, so callers can pass a fake in tests. */
export interface PreferenceStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** Minimal root-element surface (a real `HTMLElement` satisfies it). */
export interface ThemeRoot {
  setAttribute(name: string, value: string): void
}

/**
 * Build an emulator palette from a CSS custom-property lookup.
 *
 * Tokens that are missing are omitted rather than passed on as empty strings,
 * so the emulator falls back to its own default instead of painting black.
 */
export function themeFromStyles(getStyle: StyleLookup): ITheme {
  const theme: ITheme = {}
  const assign = (key: keyof ITheme, token: string) => {
    const value = getStyle(token)
    if (value) {
      theme[key] = value
    }
  }

  assign('background', '--term-bg')
  assign('foreground', '--term-fg')
  assign('cursor', '--term-cursor')
  assign('cursorAccent', '--term-cursor-accent')
  assign('selectionBackground', '--term-selection-bg')
  assign('selectionForeground', '--term-selection-fg')
  ANSI_COLORS.forEach((name, index) => {
    assign(name, `--term-ansi-${index}`)
  })

  return theme
}

/**
 * Read the palette from the live document. The colors are defined once as CSS
 * custom properties (see `index.css`) so the emulator, the pane behind it and
 * the rest of the UI can never drift apart.
 */
export function readTerminalTheme(root: HTMLElement = document.documentElement): ITheme {
  const styles = getComputedStyle(root)
  return themeFromStyles((property) => styles.getPropertyValue(property).trim())
}

/** Normalise a stored value; anything unknown means "follow the system". */
export function parsePreference(value: string | null | undefined): ThemePreference {
  return value === 'light' || value === 'dark' ? value : 'auto'
}

/** Collapse a preference and the OS setting into the scheme to render. */
export function resolveScheme(preference: ThemePreference, prefersLight: boolean): ThemeScheme {
  if (preference === 'auto') {
    return prefersLight ? 'light' : 'dark'
  }
  return preference
}

export function readStoredPreference(
  storage: PreferenceStorage | null | undefined
): ThemePreference {
  if (!storage) return 'auto'
  try {
    return parsePreference(storage.getItem(THEME_STORAGE_KEY))
  } catch {
    return 'auto'
  }
}

export function storePreference(
  storage: PreferenceStorage | null | undefined,
  preference: ThemePreference
): void {
  if (!storage) return
  try {
    storage.setItem(THEME_STORAGE_KEY, preference)
  } catch {
    // Storage can be unavailable (private mode, blocked cookies); the in-memory
    // preference still applies for this session.
  }
}

/** `localStorage` access can throw, so degrade to "no persistence". */
export function browserStorage(): PreferenceStorage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function systemPrefersLight(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches
  } catch {
    return false
  }
}

/** Point the CSS at one of the two token sets. */
export function applyScheme(root: ThemeRoot, scheme: ThemeScheme): void {
  root.setAttribute(THEME_ATTRIBUTE, scheme)
}

export interface ThemeEnvironment {
  root?: ThemeRoot
  storage?: PreferenceStorage | null
  prefersLight?: boolean
}

/**
 * Resolve and apply the scheme before React renders. Running this in `main.tsx`
 * means a light-mode user never sees a dark flash while the app boots; the
 * `useTheme` hook takes over for later changes.
 */
export function initTheme(environment: ThemeEnvironment = {}): {
  preference: ThemePreference
  scheme: ThemeScheme
} {
  // An explicit `null` means "no storage"; only an omitted option falls back to
  // the browser's, so tests can opt out of persistence.
  const storage = environment.storage === undefined ? browserStorage() : environment.storage
  const preference = readStoredPreference(storage)
  const prefersLight = environment.prefersLight ?? systemPrefersLight()
  const scheme = resolveScheme(preference, prefersLight)
  applyScheme(environment.root ?? document.documentElement, scheme)
  return { preference, scheme }
}
