import type { ServerInfoResponse } from '../../shared/types.ts'
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react'
import { type BuildInfo, describeBuild } from '../../../shared/build-info.ts'
import { api } from '../../shared/api-client.ts'
import { useDialog } from '../hooks/use-dialog.ts'
import { copyTextToClipboard } from '../lib/clipboard.ts'
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
  /**
   * A fresh mark for an action this dialog starts.
   *
   * The roll is announced to every surface, and this page shows the answer next to
   * the button - so it has to recognise its own notice and stay quiet. The mark is
   * what it recognises; the app owns the set of them, because the page's other
   * actions may claim their own.
   */
  claimActionId: () => string
  /**
   * Build identity of the server this page is talking to, or `null` while it is
   * still being fetched or if the request failed.
   */
  buildInfo: BuildInfo | null
  /**
   * The server's archive policy, or `null` while it is still being fetched.
   *
   * Shown, not edited: the caps are enforced on one shared on-disk archive, so they are
   * plugin options. A field here could only change one browser's idea of them, which is
   * why there is no field here - see `retention` in `OpencodePtyOptions`.
   */
  persist: ServerInfoResponse['persist'] | null
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
  claimActionId,
  buildInfo,
  persist,
}: SettingsModalProps) {
  const { dialogRef, handleNativeClose } = useDialog({ open, onClose, returnFocusRef, inertTarget })
  // The confirmation belongs next to the button, not in the terminal header: the
  // settings dialog is a modal on top of that header, so feedback shown there is
  // feedback the user cannot see.
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  /**
   * The roll of the daemon, and what it answered.
   *
   * The daemon is machine state that every opencode instance on the machine shares,
   * and a roll ends every session it owns - the PTY masters belong to that process.
   * So the button says so, and the answer says which pids were involved.
   */
  const [daemonState, setDaemonState] = useState<'idle' | 'running' | 'done' | 'failed'>('idle')
  const [daemonMessage, setDaemonMessage] = useState('')

  const handleRestartDaemon = useCallback(() => {
    setDaemonState('running')
    setDaemonMessage('Restarting the daemon…')
    void api.daemon
      .restart(claimActionId())
      .then((answer) => {
        setDaemonState('done')
        setDaemonMessage(
          answer.restarted
            ? `Daemon restarted: old pid ${answer.oldPid || 'none'}, new pid ${answer.newPid || 'none'}. The sessions it owned are gone.`
            : 'There is no daemon to restart.'
        )
      })
      .catch((error: unknown) => {
        setDaemonState('failed')
        setDaemonMessage(
          `The daemon could not be restarted: ${error instanceof Error ? error.message : String(error)}`
        )
      })
  }, [claimActionId])

  const handleCopyBuild = useCallback(() => {
    if (buildInfo === null) return
    void copyTextToClipboard(describeBuild(buildInfo)).then((copied) => {
      setCopyState(copied ? 'copied' : 'failed')
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
      copyTimerRef.current = setTimeout(() => setCopyState('idle'), 2000)
    })
  }, [buildInfo])

  useEffect(
    () => () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
    },
    []
  )

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

        <section className="settings-section">
          <span className="settings-label">Archive</span>
          <div className="settings-retention-values" data-testid="settings-retention">
            {persist === null ? (
              <span className="settings-retention-value">Checking…</span>
            ) : (
              <>
                <span className="settings-retention-value">
                  {persist.enabled ? 'Archiving on' : 'Archiving off'}
                </span>
                <span className="settings-retention-value">
                  keep at most {persist.retention.maxSessions} sessions
                </span>
                <span className="settings-retention-value">
                  keep sessions for {persist.retention.maxAgeDays} days
                </span>
                <span className="settings-retention-value">
                  {"rotate a session's log past "}
                  {Math.round(persist.retention.maxBytesPerSession / 1024)} KB
                </span>
                <span className="settings-retention-note">
                  set through the plugin's <code>retention</code> option; lowering a cap removes
                  sessions immediately, and they stay restorable until the next start
                </span>
              </>
            )}
          </div>
        </section>
        <section className="settings-section settings-section-build">
          <span className="settings-label">Version</span>
          {buildInfo === null ? (
            // Saying nothing beats saying "unknown": a missing value that reads
            // as missing is more useful than a confident wrong one.
            // `aria-live` rather than `aria-labelledby`: the span has no role, so
            // a labelledby would be inert, and what matters here is announcing
            // that the value arrived - the section label is already on screen.
            <span className="settings-build-value" aria-live="polite">
              Checking…
            </span>
          ) : (
            <span className="settings-build-row">
              <button
                type="button"
                className="settings-build-value"
                // A bug report needs the commit; one click saves the round trip
                // through a terminal to run `git rev-parse`.
                onClick={handleCopyBuild}
                title="Copy version and commit"
              >
                {describeBuild(buildInfo)}
              </button>
              <span className="settings-build-copied" aria-live="polite">
                {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : ''}
              </span>
            </span>
          )}
        </section>
        <section className="settings-section settings-section-daemon">
          <span className="settings-label">Daemon</span>
          <span className="settings-build-row">
            <button
              type="button"
              // Its own class, not the version's: that one is a value to copy,
              // and a locator that finds both cannot tell them apart.
              className="settings-daemon-action"
              onClick={handleRestartDaemon}
              // Disabled while a roll runs: a second one would race the first, and
              // two rolls are how the machine ends up with two daemons.
              disabled={daemonState === 'running'}
              title="Restart the daemon. Every session it owns ends with it."
            >
              {daemonState === 'running' ? 'Restarting…' : 'Restart the daemon'}
            </button>
          </span>
          {/* The answer belongs next to the button: the settings dialog is a modal
              on top of the terminal header, so feedback shown there is feedback the
              user cannot see. */}
          <span className="settings-daemon-message" aria-live="polite">
            {daemonMessage}
          </span>
        </section>
      </div>
    </dialog>
  )
}
