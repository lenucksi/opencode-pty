import { type RefObject, useCallback, useEffect, useRef } from 'react'

import type { ThemePreference } from '../lib/theme.ts'
import { MAX_TERMINAL_FONT_SIZE, MIN_TERMINAL_FONT_SIZE } from '../lib/ui-prefs.ts'
import { ThemeSwitch } from './theme-switch.tsx'

interface SettingsModalProps {
  open: boolean
  onClose: () => void
  /** Element that regains focus when the dialog closes (the Settings button). */
  returnFocusRef?: RefObject<HTMLElement | null>
  /** App shell that is made `inert` while the dialog is open. */
  inertTarget?: RefObject<HTMLElement | null>
  themePreference: ThemePreference
  onThemePreferenceChange: (preference: ThemePreference) => void
  terminalFontSize: number
  onTerminalFontSizeChange: (size: number) => void
  showDebugBar: boolean
  onShowDebugBarChange: (show: boolean) => void
}

/**
 * Settings dialog built on the native `<dialog>` element. `showModal()` gives
 * us the top layer, ESC-to-close and the focus trap for free; the extra work
 * here is keeping the React-controlled `open` prop in sync with the element and
 * making the background inert explicitly.
 */
export function SettingsModal({
  open,
  onClose,
  returnFocusRef,
  inertTarget,
  themePreference,
  onThemePreferenceChange,
  terminalFontSize,
  onTerminalFontSizeChange,
  showDebugBar,
  onShowDebugBarChange,
}: SettingsModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  // Read at event time: the native `close` event also fires when we close the
  // dialog ourselves, and only a user-initiated close should notify the parent.
  const openRef = useRef(open)
  openRef.current = open
  const wasOpenRef = useRef(false)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) {
      dialog.showModal()
    } else if (!open && dialog.open) {
      dialog.close()
    }
  }, [open])

  // `showModal()` already makes the rest of the document inert, but setting the
  // attribute explicitly documents the intent and keeps the app shell out of the
  // tab order on browsers with a partial top-layer implementation.
  useEffect(() => {
    const target = inertTarget?.current
    if (!target) return
    if (open) {
      target.setAttribute('inert', '')
    } else {
      target.removeAttribute('inert')
    }
    return () => target.removeAttribute('inert')
  }, [open, inertTarget])

  // Focus returns to the trigger once the background is interactive again. The
  // effect order matters: the inert attribute is removed above before this runs.
  useEffect(() => {
    if (open) {
      wasOpenRef.current = true
      return
    }
    if (!wasOpenRef.current) return
    wasOpenRef.current = false
    returnFocusRef?.current?.focus()
  }, [open, returnFocusRef])

  const handleNativeClose = useCallback(() => {
    if (openRef.current) onClose()
  }, [onClose])

  // Clicks on the backdrop are dispatched at the dialog element itself; clicks
  // on the panel target its children. The listener is attached imperatively so
  // the non-interactive dialog needs no JSX click handler.
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const onClick = (event: MouseEvent) => {
      if (event.target === dialog) onClose()
    }
    dialog.addEventListener('click', onClick)
    return () => dialog.removeEventListener('click', onClick)
  }, [onClose])

  return (
    <dialog
      ref={dialogRef}
      className="settings-dialog"
      aria-labelledby="settings-dialog-title"
      onClose={handleNativeClose}
    >
      <div className="settings-panel">
        <header className="settings-panel-header">
          <h2 id="settings-dialog-title" className="settings-title">
            Settings
          </h2>
          <button
            type="button"
            className="settings-close"
            onClick={onClose}
            aria-label="Close settings"
          >
            ×
          </button>
        </header>

        <section className="settings-section">
          <span className="settings-label">Theme</span>
          <ThemeSwitch preference={themePreference} onChange={onThemePreferenceChange} />
        </section>

        <section className="settings-section">
          <label className="settings-label" htmlFor="settings-font-size">
            Terminal font size
          </label>
          <div className="settings-font-size">
            <input
              id="settings-font-size"
              type="range"
              min={MIN_TERMINAL_FONT_SIZE}
              max={MAX_TERMINAL_FONT_SIZE}
              step={1}
              value={terminalFontSize}
              onChange={(event) => onTerminalFontSizeChange(Number(event.target.value))}
            />
            <span className="settings-font-size-value" aria-live="polite">
              {terminalFontSize}px
            </span>
          </div>
        </section>

        <section className="settings-section">
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={showDebugBar}
              onChange={(event) => onShowDebugBarChange(event.target.checked)}
            />
            Show debug bar
          </label>
        </section>
      </div>
    </dialog>
  )
}
