import { type RefObject, useCallback, useEffect, useRef } from 'react'
import type { PTYSessionInfo } from 'opencode-pty/web/shared/types'
import type { RawTerminal } from '../components/terminal-renderer.ts'

interface UseTerminalResizeOptions {
  activeSession: PTYSessionInfo | null
  connected: boolean
  sendResize: (sessionId: string, cols: number, rows: number) => void
  terminalRef: RefObject<RawTerminal | null>
}

const REFIT_DEBOUNCE_MS = 100

/**
 * Keeps the PTY size in sync with the terminal viewport: reports resize events,
 * re-sends the last known size once a session is subscribed, and refits the
 * emulator when its container changes size.
 *
 * The fit is what sizes the emulator's canvas (which in turn is the only
 * selectable surface), so a missed fit leaves a stale grid: the terminal then
 * renders and selects only in the part of the pane the canvas still covers.
 */
export function useTerminalResize({
  activeSession,
  connected,
  sendResize,
  terminalRef,
}: UseTerminalResizeOptions) {
  const outputContainerRef = useRef<HTMLDivElement>(null)
  const terminalSizeRef = useRef<{ cols: number; rows: number } | null>(null)

  const handleTerminalResize = useCallback(
    (cols: number, rows: number) => {
      if (cols <= 0 || rows <= 0) return
      terminalSizeRef.current = { cols, rows }
      if (activeSession) {
        sendResize(activeSession.id, cols, rows)
      }
    },
    [activeSession, sendResize]
  )

  // Re-send the known terminal size after connecting/subscribing or when the
  // active session changes, so a freshly subscribed PTY matches the viewport
  // even before the next ResizeObserver tick.
  useEffect(() => {
    if (!connected || !activeSession) return
    const size = terminalSizeRef.current
    if (!size) return
    sendResize(activeSession.id, size.cols, size.rows)
  }, [connected, activeSession, sendResize])

  // Refit whenever the pane changes size. A leading fit runs immediately and a
  // debounced trailing fit catches layout that only settles a tick later (font
  // metrics, flex sizing, WASM readiness). The terminal element is observed as
  // well, since the container can keep its size while the emulator changes.
  useEffect(() => {
    // The pane (and therefore its ref) only exists while a session is selected,
    // so the observer is (re)attached whenever that changes.
    if (!activeSession) return

    const container = outputContainerRef.current
    if (!container) return

    let timer: ReturnType<typeof setTimeout> | undefined
    const refit = () => terminalRef.current?.fit()
    const scheduleTrailing = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(refit, REFIT_DEBOUNCE_MS)
    }

    const observer = new ResizeObserver(() => {
      refit()
      scheduleTrailing()
    })
    observer.observe(container)
    const terminalEl = container.querySelector('.terminal')
    if (terminalEl) {
      observer.observe(terminalEl)
    }

    // The observer's first callback fires when it is attached, but the emulator
    // may not be ready by then (its `fit()` is deferred to ready), so fit once
    // on attach as well.
    refit()

    return () => {
      if (timer) clearTimeout(timer)
      observer.disconnect()
    }
  }, [activeSession, terminalRef])

  // Window-level fallback: the container observer is recreated on session
  // switches and can miss a size change in that window, so also refit on
  // viewport changes and when the tab becomes visible again.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const refit = () => terminalRef.current?.fit()
    const onChange = () => {
      refit()
      if (timer) clearTimeout(timer)
      timer = setTimeout(refit, REFIT_DEBOUNCE_MS)
    }
    window.addEventListener('resize', onChange)
    document.addEventListener('visibilitychange', onChange)
    return () => {
      if (timer) clearTimeout(timer)
      window.removeEventListener('resize', onChange)
      document.removeEventListener('visibilitychange', onChange)
    }
  }, [terminalRef])

  return { outputContainerRef, handleTerminalResize }
}
