import { useCallback, useEffect, useState } from 'react'
import {
  applyScheme,
  browserStorage,
  readStoredPreference,
  resolveScheme,
  storePreference,
  systemPrefersLight,
  type ThemePreference,
  type ThemeScheme,
} from '../lib/theme.ts'

interface UseThemeResult {
  /** What the user picked (`auto` follows the OS). */
  preference: ThemePreference
  /** The scheme actually being rendered. */
  scheme: ThemeScheme
  setPreference: (preference: ThemePreference) => void
}

/**
 * Track the app theme: read the stored preference, follow OS changes while the
 * preference is `auto`, keep the `<html>` attribute in sync (the CSS tokens and
 * the terminal palette both key off it) and expose a setter for the UI.
 */
export function useTheme(): UseThemeResult {
  const [preference, setPreferenceState] = useState<ThemePreference>(() =>
    readStoredPreference(browserStorage())
  )
  const [prefersLight, setPrefersLight] = useState<boolean>(() => systemPrefersLight())

  // The OS setting is tracked unconditionally, but only affects `scheme` while
  // the preference is `auto` (see `resolveScheme`).
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(prefers-color-scheme: light)')
    const onChange = (event: MediaQueryListEvent) => setPrefersLight(event.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  const scheme = resolveScheme(preference, prefersLight)

  // `initTheme` (main.tsx) already applied the initial scheme before the first
  // render; this keeps the attribute current for every later change.
  useEffect(() => {
    applyScheme(document.documentElement, scheme)
  }, [scheme])

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next)
    storePreference(browserStorage(), next)
  }, [])

  return { preference, scheme, setPreference }
}
