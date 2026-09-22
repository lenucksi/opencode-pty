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

const RECONNECT_MIN_DELAY = RETRY_DELAY
const RECONNECT_MAX_DELAY = 10_000
/**
 * Silence threshold before a socket is treated as dead. A half-open connection
 * (laptop suspend, network drop) never fires `close`, and without this the
 * session list would freeze with no way to notice.
 */
const STALE_SOCKET_MS = 45_000
const WATCHDOG_INTERVAL_MS = 5_000

export function useWebSocket({
  activeSession,
  onRawData,
  onSessionList,
  onSessionUpdate,
  onSessionRemoved,
}: UseWebSocketOptions) {
  const [connected, setConnected] = useState(false)

  const wsRef = useRef<WebSocket | null>(null)
  /** Last time any message arrived; the watchdog and the tab-return check use it. */
  const lastMessageAtRef = useRef(0)
  const activeSessionRef = useRef<PTYSessionInfo | null>(activeSession)
  // Handlers live in a ref so changing them (props change on every render)
  // never tears down the socket. The connection is created once and kept for
  // the lifetime of the component; the server pushes list/update/removed
  // events, so there is no need to reconnect on session switches.
  const handlersRef = useRef({ onRawData, onSessionList, onSessionUpdate, onSessionRemoved })

  useEffect(() => {
    activeSessionRef.current = activeSession
  }, [activeSession])

  useEffect(() => {
    handlersRef.current = { onRawData, onSessionList, onSessionUpdate, onSessionRemoved }
  })

  useEffect(() => {
    let closedByUs = false
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined
    let watchdogTimer: ReturnType<typeof setInterval> | undefined
    let attempts = 0

    const send = (message: unknown) => {
      const ws = wsRef.current
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message))
      }
    }

    const connect = () => {
      const ws = new WebSocket(`ws://${location.host}/ws`)
      wsRef.current = ws
      lastMessageAtRef.current = Date.now()

      const isStale = () => Date.now() - lastMessageAtRef.current >= STALE_SOCKET_MS

      // Closing a stale socket runs the normal close path, which reconnects and
      // resyncs the session list.
      const dropIfStale = () => {
        if (wsRef.current !== ws) return
        if (ws.readyState === WebSocket.OPEN && isStale()) ws.close()
      }

      watchdogTimer = setInterval(dropIfStale, WATCHDOG_INTERVAL_MS)

      ws.onopen = () => {
        attempts = 0
        lastMessageAtRef.current = Date.now()
        setConnected(true)
        // The server does not replay events that happened while we were
        // disconnected, so resync the list and re-subscribe the active session.
        send({ type: 'session_list' })
        const active = activeSessionRef.current
        if (active) {
          send({ type: 'subscribe', sessionId: active.id })
        }
      }

      ws.onmessage = (event) => {
        lastMessageAtRef.current = Date.now()
        try {
          const data = JSON.parse(event.data) as WSMessageServer
          const handlers = handlersRef.current

          if (data.type === 'session_list') {
            const sessions = (data as WSMessageServerSessionList).sessions || []
            // Auto-select the first running session if none is selected (skipped
            // in tests that need the empty state).
            const shouldSkipAutoselect = localStorage.getItem(SKIP_AUTOSELECT_KEY) === 'true'
            let autoSelected: PTYSessionInfo | null = null
            if (sessions.length > 0 && !activeSessionRef.current && !shouldSkipAutoselect) {
              autoSelected = sessions.find((s) => s.status === 'running') ?? sessions[0] ?? null
              if (autoSelected) {
                activeSessionRef.current = autoSelected
                send({ type: 'subscribe', sessionId: autoSelected.id })
              }
            }
            handlers.onSessionList(sessions, autoSelected)
          } else if (data.type === 'session_update') {
            handlers.onSessionUpdate?.((data as WSMessageServerSessionUpdate).session)
          } else if (data.type === 'session_removed') {
            handlers.onSessionRemoved?.((data as WSMessageServerSessionRemoved).sessionId)
          } else if (data.type === 'raw_data') {
            const rawDataMsg = data as WSMessageServerRawData
            if (rawDataMsg.sessionId === activeSessionRef.current?.id) {
              handlers.onRawData?.(rawDataMsg)
            }
          } else if (data.type === 'error') {
            console.warn('WebSocket server error:', (data as WSMessageServerError).error)
          }
          // `subscribed`, `unsubscribed`, and `readRawResponse` are intentionally
          // ignored: subscription state is tracked locally and raw buffers are
          // read over HTTP.
        } catch (error) {
          console.warn('Failed to parse WebSocket message', error)
        }
      }

      ws.onclose = () => {
        if (watchdogTimer !== undefined) {
          clearInterval(watchdogTimer)
          watchdogTimer = undefined
        }
        setConnected(false)
        if (closedByUs) {
          return
        }
        const delay = Math.min(RECONNECT_MAX_DELAY, RECONNECT_MIN_DELAY * 2 ** attempts)
        attempts += 1
        reconnectTimer = setTimeout(connect, delay)
      }

      ws.onerror = () => {
        // Closing triggers onclose, which schedules the reconnect.
        ws.close()
      }
    }

    connect()

    // Coming back to a suspended tab should not wait for the watchdog tick.
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        const ws = wsRef.current
        if (!ws || ws.readyState !== WebSocket.OPEN) return
        const age = Date.now() - lastMessageAtRef.current
        if (age >= STALE_SOCKET_MS) ws.close()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      closedByUs = true
      document.removeEventListener('visibilitychange', onVisibility)
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
      }
      if (watchdogTimer !== undefined) {
        clearInterval(watchdogTimer)
      }
      wsRef.current?.close()
    }
  }, [])

  const subscribe = useCallback((sessionId: string) => {
    const ws = wsRef.current
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'subscribe', sessionId }))
    }
  }, [])

  const subscribeWithRetry = useCallback(
    (sessionId: string) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        subscribe(sessionId)
      } else {
        setTimeout(() => {
          subscribe(sessionId)
        }, RETRY_DELAY)
      }
    },
    [subscribe]
  )

  const sendInput = useCallback((sessionId: string, data: string) => {
    const ws = wsRef.current
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', sessionId, data }))
    }
  }, [])

  const sendResize = useCallback((sessionId: string, cols: number, rows: number) => {
    const ws = wsRef.current
    if (ws?.readyState === WebSocket.OPEN) {
      const message: WSMessageClientResize = { type: 'resize', sessionId, cols, rows }
      ws.send(JSON.stringify(message))
    }
  }, [])

  return { connected, subscribe, subscribeWithRetry, sendInput, sendResize }
}
