import { useState, useEffect, useCallback, useRef } from 'react'
import type { PTYSessionInfo, WSMessageServerRawData } from 'opencode-pty/web/shared/types'

import { useWebSocket } from '../hooks/use-web-socket.ts'
import { useSessionManager } from '../hooks/use-session-manager.ts'
import { useRawStream } from '../hooks/use-raw-stream.ts'

import { Sidebar } from './sidebar.tsx'
import { RawTerminal } from './terminal-renderer.tsx'
import { api } from '../../shared/api-client.ts'

export function App() {
  const [sessions, setSessions] = useState<PTYSessionInfo[]>([])
  const [activeSession, setActiveSession] = useState<PTYSessionInfo | null>(null)

  const [connected, setConnected] = useState(false)
  const [wsMessageCount, setWsMessageCount] = useState(0)
  const [sessionUpdateCount, setSessionUpdateCount] = useState(0)

  const { rawOutput, reset: resetRawStream, applyChunk, applySnapshot, getOffset } = useRawStream()

  const activeSessionIdRef = useRef<string | null>(null)
  const resyncingRef = useRef(false)

  useEffect(() => {
    activeSessionIdRef.current = activeSession?.id ?? null
  }, [activeSession])

  const resync = useCallback(
    async (sessionId: string) => {
      if (resyncingRef.current) {
        return
      }
      resyncingRef.current = true
      try {
        const since = getOffset()
        const data = await api.session.buffer.raw({ id: sessionId, since })
        if (activeSessionIdRef.current !== sessionId) {
          return
        }
        applySnapshot({ raw: data.raw || '', offset: data.offset })
      } catch (error) {
        console.error('Failed to resync raw buffer snapshot', error)
      } finally {
        resyncingRef.current = false
      }
    },
    [getOffset, applySnapshot]
  )

  const {
    connected: wsConnected,
    subscribeWithRetry,
    sendInput,
  } = useWebSocket({
    activeSession,
    onRawData: useCallback(
      (message: WSMessageServerRawData) => {
        setWsMessageCount((prev) => prev + 1)
        const result = applyChunk({ rawData: message.rawData, offset: message.offset })
        if (result === 'gap') {
          void resync(message.sessionId)
        }
      },
      [applyChunk, resync]
    ),
    onSessionList: useCallback(
      (newSessions: PTYSessionInfo[], autoSelected: PTYSessionInfo | null) => {
        setSessions(newSessions)
        if (!autoSelected) {
          return
        }
        setActiveSession(autoSelected)
        resetRawStream()
        api.session.buffer
          .raw({ id: autoSelected.id, since: getOffset() })
          .then((data) => {
            applySnapshot({ raw: data.raw || '', offset: data.offset })
          })
          .catch((error) => {
            console.error('Failed to fetch initial raw buffer for auto-selected session', error)
          })
      },
      [resetRawStream, applySnapshot, getOffset]
    ),
    onSessionUpdate: useCallback((updatedSession: PTYSessionInfo) => {
      setSessionUpdateCount((prev) => prev + 1)
      setSessions((prevSessions) => {
        const existingIndex = prevSessions.findIndex((s) => s.id === updatedSession.id)
        if (existingIndex >= 0) {
          // Replace the existing session
          const newSessions = [...prevSessions]
          newSessions[existingIndex] = updatedSession
          return newSessions
        } else {
          // Add the new session to the list
          return [...prevSessions, updatedSession]
        }
      })
    }, []),
  })

  // Update connected from wsConnected
  useEffect(() => {
    setConnected(wsConnected)
  }, [wsConnected])

  // Periodic session list sync every 10 seconds
  useEffect(() => {
    const syncInterval = setInterval(async () => {
      try {
        setSessions(await api.sessions.list())
      } catch (error) {
        console.error('Failed to sync sessions', error)
      }
    }, 10000) // 10 seconds

    return () => clearInterval(syncInterval)
  }, [])

  const { handleSessionClick, handleSendInput, handleKillSession } = useSessionManager({
    activeSession,
    setActiveSession,
    subscribeWithRetry,
    sendInput,
    wsConnected,
    onSessionReset: resetRawStream,
    onSnapshot: applySnapshot,
    getSinceOffset: getOffset,
  })

  return (
    <div className="container" data-active-session={activeSession?.id}>
      <Sidebar
        sessions={sessions}
        activeSession={activeSession}
        onSessionClick={handleSessionClick}
        connected={connected}
      />
      <div className="main">
        {activeSession ? (
          <>
            <div className="output-header">
              <div className="output-title">{activeSession.description ?? activeSession.title}</div>
              <button type="button" className="kill-btn" onClick={handleKillSession}>
                Kill Session
              </button>
            </div>
            <div className="output-container">
              <RawTerminal
                key={activeSession?.id}
                rawOutput={rawOutput}
                onSendInput={handleSendInput}
                onInterrupt={handleKillSession}
                disabled={!activeSession || activeSession.status !== 'running'}
              />
            </div>
            <div className="debug-info" data-testid="debug-info">
              Debug: {rawOutput.length} chars, active: {activeSession?.id || 'none'}, WS raw_data:{' '}
              {wsMessageCount}, session_updates: {sessionUpdateCount}
            </div>
          </>
        ) : (
          <div className="empty-state">Select a session from the sidebar to view its output</div>
        )}
      </div>
    </div>
  )
}
