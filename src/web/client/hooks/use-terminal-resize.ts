import { type RefObject, useCallback, useEffect, useRef } from 'react'
import type { PTYSessionInfo } from 'opencode-pty/web/shared/types'
import type { RawTerminal } from '../components/terminal-renderer.ts'

interface UseTerminalResizeOptions {
  activeSession: PTYSessionInfo | null
  connected: boolean
  sendResize: (sessionId: string, cols: number, rows: number) => void
  terminalRef: RefObject<RawTerminal>
}

/**
 * Keeps the PTY size in sync with the terminal viewport: reports resize events,
 * re-sends the last known size once a session is subscribed, and refits the
 * emulator when its container changes size.
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

  // Refit the terminal (and thereby report new cols/rows) when its container
  // changes size. Debounced to avoid resize storms while dragging.
  useEffect(() => {
    const container = outputContainerRef.current
    if (!container || !activeSession) return

    let timer: ReturnType<typeof setTimeout> | undefined
    const observer = new ResizeObserver(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        terminalRef.current?.fit()
      }, 100)
    })
    observer.observe(container)

    return () => {
      if (timer) clearTimeout(timer)
      observer.disconnect()
    }
  }, [activeSession, terminalRef])

  return { outputContainerRef, handleTerminalResize }
}
