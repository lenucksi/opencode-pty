import { useCallback, useEffect, useState } from 'react'
import { browserStorage } from '../lib/theme.ts'
import { clampFontSize, readUiPrefs, storeUiPrefs, type UiPrefs } from '../lib/ui-prefs.ts'

interface UseUiPrefsResult {
  prefs: UiPrefs
  setTerminalFontSize: (size: number) => void
  setShowDebugBar: (show: boolean) => void
}

/**
 * Track the UI preferences: read the stored values once, expose clamped setters
 * and persist every change. The write happens in an effect rather than in the
 * setter so a React StrictMode double-invoke cannot produce duplicate writes.
 */
export function useUiPrefs(): UseUiPrefsResult {
  const [prefs, setPrefs] = useState<UiPrefs>(() => readUiPrefs(browserStorage()))

  useEffect(() => {
    storeUiPrefs(browserStorage(), prefs)
  }, [prefs])

  const setTerminalFontSize = useCallback((size: number) => {
    setPrefs((prev) => ({ ...prev, terminalFontSize: clampFontSize(size) }))
  }, [])

  const setShowDebugBar = useCallback((show: boolean) => {
    setPrefs((prev) => ({ ...prev, showDebugBar: show }))
  }, [])

  return { prefs, setTerminalFontSize, setShowDebugBar }
}
