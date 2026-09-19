import { useState, useEffect, useRef, useCallback } from 'react'
import type {
  PTYSessionInfo,
  WSMessageServer,
  WSMessageServerError,
  WSMessageServerRawData,
  WSMessageServerSessionList,
  WSMessageServerSessionRemoved,
  WSMessageServerSessionUpdate,
  WSMessageClientResize,
} from 'opencode-pty/web/shared/types'
import { RETRY_DELAY, SKIP_AUTOSELECT_KEY } from 'opencode-pty/web/shared/constants'

interface UseWebSocketOptions {
  activeSession: PTYSessionInfo | null
  onRawData?: (message: WSMessageServerRawData) => void
  onSessionList: (sessions: PTYSessionInfo[], autoSelected: PTYSessionInfo | null) => void
  onSessionUpdate?: (updatedSession: PTYSessionInfo) => void
  onSessionRemoved?: (sessionId: string) => void
}

export function useWebSocket({
  activeSession,
  onRawData,
  onSessionList,
  onSessionUpdate,
  onSessionRemoved,
}: UseWebSocketOptions) {
  const [connected, setConnected] = useState(false)

  const wsRef = useRef<WebSocket | null>(null)
  const activeSessionRef = useRef<PTYSessionInfo | null>(null)

  // Keep ref in sync with activeSession
  useEffect(() => {
    activeSessionRef.current = activeSession
  }, [activeSession])

  // Connect to WebSocket on mount
  useEffect(() => {
    const ws = new WebSocket(`ws://${location.host}/ws`)
    ws.onopen = () => {
      setConnected(true)
      // Request initial session list
      ws.send(JSON.stringify({ type: 'session_list' }))
      // Resubscribe to active session if exists
      if (activeSessionRef.current) {
        ws.send(JSON.stringify({ type: 'subscribe', sessionId: activeSessionRef.current.id }))
      }
    }
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as WSMessageServer
        if (data.type === 'session_list') {
          const sessionListMsg = data as WSMessageServerSessionList
          const sessions = sessionListMsg.sessions || []
          // Auto-select first running session if none selected (skip in tests that need empty state)
          const shouldSkipAutoselect = localStorage.getItem(SKIP_AUTOSELECT_KEY) === 'true'
          let autoSelected: PTYSessionInfo | null = null
          if (sessions.length > 0 && !activeSession && !shouldSkipAutoselect) {
            const runningSession =
              sessions.find((s: PTYSessionInfo) => s.status === 'running') || null
            autoSelected = runningSession || sessions[0] || null
            if (autoSelected) {
              activeSessionRef.current = autoSelected
              // Subscribe to the auto-selected session for live updates
              const readyState = wsRef.current?.readyState

              if (readyState === WebSocket.OPEN && wsRef.current) {
                wsRef.current.send(
                  JSON.stringify({ type: 'subscribe', sessionId: autoSelected.id })
                )
              } else {
                setTimeout(
                  (autoSelected) => {
                    const retryReadyState = wsRef.current?.readyState
                    if (retryReadyState === WebSocket.OPEN && wsRef.current) {
                      wsRef.current.send(
                        JSON.stringify({ type: 'subscribe', sessionId: autoSelected.id })
                      )
                    }
                  },
                  RETRY_DELAY,
                  autoSelected
                )
              }
            }
          }
          onSessionList(sessions, autoSelected)
        } else if (data.type === 'session_update') {
          const sessionUpdateMsg = data as WSMessageServerSessionUpdate
          onSessionUpdate?.(sessionUpdateMsg.session)
        } else if (data.type === 'session_removed') {
          const sessionRemovedMsg = data as WSMessageServerSessionRemoved
          onSessionRemoved?.(sessionRemovedMsg.sessionId)
        } else if (data.type === 'raw_data') {
          const rawDataMsg = data as WSMessageServerRawData
          const isForActiveSession = rawDataMsg.sessionId === activeSessionRef.current?.id
          if (isForActiveSession) {
            onRawData?.(rawDataMsg)
          }
        } else if (data.type === 'error') {
          const errorMsg = data as WSMessageServerError
          console.warn('WebSocket server error:', errorMsg.error)
        }
        // `subscribed`, `unsubscribed`, and `readRawResponse` are intentionally
        // ignored: the client tracks subscription state locally and reads raw
        // buffers over HTTP.
      } catch (error) {
        console.warn('Failed to parse WebSocket message', error)
      }
    }
    ws.onclose = () => {
      setConnected(false)
    }
    ws.onerror = () => {}
    wsRef.current = ws
    return () => {
      ws.close()
    }
  }, [activeSession, onRawData, onSessionList, onSessionUpdate, onSessionRemoved])

  const subscribe = (sessionId: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'subscribe', sessionId }))
    }
  }

  const subscribeWithRetry = (sessionId: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      subscribe(sessionId)
    } else {
      setTimeout(() => {
        subscribe(sessionId)
      }, RETRY_DELAY)
    }
  }

  const sendInput = (sessionId: string, data: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'input', sessionId, data }))
    }
  }

  const sendResize = useCallback((sessionId: string, cols: number, rows: number) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const message: WSMessageClientResize = { type: 'resize', sessionId, cols, rows }
      wsRef.current.send(JSON.stringify(message))
    }
  }, [])

  return { connected, subscribe, subscribeWithRetry, sendInput, sendResize }
}
