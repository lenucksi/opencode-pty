import type { PreferenceStorage } from './theme.ts'

/** Key under which the UI preferences are stored as a JSON blob. */
export const UI_PREFS_STORAGE_KEY = 'opencode-pty-ui-prefs'

export const MIN_TERMINAL_FONT_SIZE = 10
export const MAX_TERMINAL_FONT_SIZE = 24
export const DEFAULT_TERMINAL_FONT_SIZE = 14
export const DEFAULT_SHOW_DEBUG_BAR = true

/** Client-side presentation preferences that are not part of the server API. */
export interface UiPrefs {
  /** Terminal font size in CSS pixels. */
  terminalFontSize: number
  /** Whether the diagnostics bar under the terminal is rendered. */
  showDebugBar: boolean
}

export const DEFAULT_UI_PREFS: UiPrefs = {
  terminalFontSize: DEFAULT_TERMINAL_FONT_SIZE,
  showDebugBar: DEFAULT_SHOW_DEBUG_BAR,
}

/**
 * Clamp a font size to the supported range. Non-finite input (a corrupt stored
 * value, `Number('')`, …) falls back to the default rather than clamping to an
 * arbitrary bound.
 */
export function clampFontSize(size: number): number {
  if (!Number.isFinite(size)) return DEFAULT_TERMINAL_FONT_SIZE
  const rounded = Math.round(size)
  return Math.min(MAX_TERMINAL_FONT_SIZE, Math.max(MIN_TERMINAL_FONT_SIZE, rounded))
}

function coerceFontSize(value: unknown): number {
  return typeof value === 'number' ? clampFontSize(value) : DEFAULT_TERMINAL_FONT_SIZE
}

/**
 * Parse a stored JSON blob, filling in defaults for missing or invalid fields.
 * Anything that is not a JSON object with recognised fields yields the default
 * preferences; individual bad fields never discard the good ones.
 */
export function parseUiPrefs(value: string | null | undefined): UiPrefs {
  if (!value) return { ...DEFAULT_UI_PREFS }

  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return { ...DEFAULT_UI_PREFS }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ...DEFAULT_UI_PREFS }
  }

  const record = parsed as Record<string, unknown>
  return {
    terminalFontSize: coerceFontSize(record.terminalFontSize),
    showDebugBar:
      typeof record.showDebugBar === 'boolean' ? record.showDebugBar : DEFAULT_SHOW_DEBUG_BAR,
  }
}

/** Read the preferences, degrading to defaults when storage is unavailable. */
export function readUiPrefs(storage: PreferenceStorage | null | undefined): UiPrefs {
  if (!storage) return { ...DEFAULT_UI_PREFS }
  try {
    return parseUiPrefs(storage.getItem(UI_PREFS_STORAGE_KEY))
  } catch {
    return { ...DEFAULT_UI_PREFS }
  }
}

/**
 * Persist the preferences. The font size is clamped on the way out so a corrupt
 * in-memory value can never be written back. Storage failures are swallowed for
 * the same reason as in `lib/theme.ts`: the in-memory preference still applies
 * for this session.
 */
export function storeUiPrefs(storage: PreferenceStorage | null | undefined, prefs: UiPrefs): void {
  if (!storage) return
  const payload: UiPrefs = {
    terminalFontSize: clampFontSize(prefs.terminalFontSize),
    showDebugBar: prefs.showDebugBar,
  }
  try {
    storage.setItem(UI_PREFS_STORAGE_KEY, JSON.stringify(payload))
  } catch {
    // Storage can be unavailable (private mode, blocked cookies).
  }
}
