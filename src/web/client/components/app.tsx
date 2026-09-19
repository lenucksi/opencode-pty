import { type RefObject, useCallback, useEffect, useRef, useState } from 'react'
import type { PTYSessionInfo, WSMessageServerRawData } from 'opencode-pty/web/shared/types'

import { useWebSocket } from '../hooks/use-web-socket.ts'
import { useSessionManager } from '../hooks/use-session-manager.ts'
import { useRawStream } from '../hooks/use-raw-stream.ts'
import { useTerminalResize } from '../hooks/use-terminal-resize.ts'
import type { RenderIntent } from '../lib/raw-stream.ts'

import { Sidebar } from './sidebar.tsx'
import { RawTerminal } from './terminal-renderer.tsx'
import { api } from '../../shared/api-client.ts'

function usePeriodicSessionSync(setSessions: (sessions: PTYSessionInfo[]) => void): void {
  useEffect(() => {
    const syncInterval = setInterval(async () => {
      try {
        setSessions(await api.sessions.list())
      } catch (error) {
        console.error('Failed to sync sessions', error)
      }
    }, 10000)

    return () => clearInterval(syncInterval)
  }, [setSessions])
}

interface ActiveSessionViewProps {
  activeSession: PTYSessionInfo
  terminalRef: RefObject<RawTerminal>
  outputContainerRef: RefObject<HTMLDivElement>
  charCount: number
  wsMessageCount: number
  sessionUpdateCount: number
  onTerminalResize: (cols: number, rows: number) => void
  onSendInput: (data: string) => void
  onKillSession: () => void
}

function ActiveSessionView({
  activeSession,
  terminalRef,
  outputContainerRef,
  charCount,
  wsMessageCount,
  sessionUpdateCount,
  onTerminalResize,
  onSendInput,
  onKillSession,
}: ActiveSessionViewProps) {
  return (
    <>
      <div className="output-header">
        <div className="output-title">{activeSession.description ?? activeSession.title}</div>
        <button type="button" className="kill-btn" onClick={onKillSession}>
          Kill Session
        </button>
      </div>
      <div className="output-container" ref={outputContainerRef}>
        <RawTerminal
          ref={terminalRef}
          onSendInput={onSendInput}
          onInterrupt={onKillSession}
          onResize={onTerminalResize}
          disabled={activeSession.status !== 'running'}
        />
      </div>
      <div className="debug-info" data-testid="debug-info">
        Debug: chars: {charCount}, active: {activeSession.id || 'none'}, WS raw_data:{' '}
        {wsMessageCount}, session_updates: {sessionUpdateCount}
      </div>
    </>
  )
}

export function App() {
  const [sessions, setSessions] = useState<PTYSessionInfo[]>([])
  const [activeSession, setActiveSession] = useState<PTYSessionInfo | null>(null)
  const [wsMessageCount, setWsMessageCount] = useState(0)
  const [sessionUpdateCount, setSessionUpdateCount] = useState(0)

  const terminalRef = useRef<RawTerminal>(null)

  const handleTerminalRender = useCallback((intent: RenderIntent) => {
    terminalRef.current?.applyRender(intent)
  }, [])

  const {
    reset: resetRawStream,
    applyChunk,
    applySnapshot,
    getOffset,
    charCount,
  } = useRawStream(handleTerminalRender)

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
    sendResize,
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
          const newSessions = [...prevSessions]
          newSessions[existingIndex] = updatedSession
          return newSessions
        }
        return [...prevSessions, updatedSession]
      })
    }, []),
  })

  const { outputContainerRef, handleTerminalResize } = useTerminalResize({
    activeSession,
    connected: wsConnected,
    sendResize,
    terminalRef,
  })

  usePeriodicSessionSync(setSessions)

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
        connected={wsConnected}
      />
      <div className="main">
        {activeSession ? (
          <ActiveSessionView
            activeSession={activeSession}
            terminalRef={terminalRef}
            outputContainerRef={outputContainerRef}
            charCount={charCount}
            wsMessageCount={wsMessageCount}
            sessionUpdateCount={sessionUpdateCount}
            onTerminalResize={handleTerminalResize}
            onSendInput={handleSendInput}
            onKillSession={handleKillSession}
          />
        ) : (
          <div className="empty-state">Select a session from the sidebar to view its output</div>
        )}
      </div>
    </div>
  )
}
