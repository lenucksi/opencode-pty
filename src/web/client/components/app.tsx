import { type RefObject, useCallback, useEffect, useRef, useState } from 'react'
import type { PTYSessionInfo, WSMessageServerRawData } from 'opencode-pty/web/shared/types'
import { sessionDetailLine, sessionTooltip, sortSessionsByTime } from '../../shared/session-meta.ts'

import { useWebSocket } from '../hooks/use-web-socket.ts'
import { useSessionManager } from '../hooks/use-session-manager.ts'
import { useRawStream } from '../hooks/use-raw-stream.ts'
import { useTerminalResize } from '../hooks/use-terminal-resize.ts'
import { useTheme } from '../hooks/use-theme.ts'
import { useUiPrefs } from '../hooks/use-ui-prefs.ts'
import { copyTextToClipboard } from '../lib/clipboard.ts'
import type { RenderIntent } from '../lib/raw-stream.ts'
import type { ThemeScheme } from '../lib/theme.ts'

import { DocsModal } from './docs-modal.tsx'
import { DownloadMenu } from './download-menu.tsx'
import { RemoveSessionsDialog, UndoToast } from './remove-sessions-dialog.tsx'
import { Sidebar } from './sidebar.tsx'
import { SettingsModal } from './settings-modal.tsx'
import { RawTerminal } from './terminal-renderer.tsx'
import { api } from '../../shared/api-client.ts'
import type { BuildInfo } from '../../../shared/build-info.ts'

/** A session is live until its process has actually exited. */
function isLiveStatus(status: PTYSessionInfo['status']): boolean {
  return status === 'running' || status === 'killing'
}

interface ActiveSessionViewProps {
  activeSession: PTYSessionInfo
  terminalRef: RefObject<RawTerminal | null>
  outputContainerRef: RefObject<HTMLDivElement | null>
  charCount: number
  wsMessageCount: number
  sessionUpdateCount: number
  colorScheme: ThemeScheme
  terminalFontSize: number
  showDebugBar: boolean
  copyFeedback: string
  onTerminalResize: (cols: number, rows: number) => void
  onSendInput: (data: string) => void
  onCopy: () => void
  onCopyAll: () => void
  onKillSession: () => void
  onRemoveSession: () => void
}

function ActiveSessionView({
  activeSession,
  terminalRef,
  outputContainerRef,
  charCount,
  wsMessageCount,
  sessionUpdateCount,
  colorScheme,
  terminalFontSize,
  showDebugBar,
  copyFeedback,
  onTerminalResize,
  onSendInput,
  onCopy,
  onCopyAll,
  onKillSession,
  onRemoveSession,
}: ActiveSessionViewProps) {
  return (
    <>
      <div className="output-header">
        <div className="output-titles">
          <div className="output-title">{activeSession.description ?? activeSession.title}</div>
          <div className="output-subtitle" title={sessionTooltip(activeSession)}>
            {sessionDetailLine(activeSession)}
          </div>
        </div>
        <div className="output-actions">
          <span className="copy-feedback" aria-live="polite" data-testid="copy-feedback">
            {copyFeedback}
          </span>
          <DownloadMenu sessionId={activeSession.id} />
          <button
            type="button"
            className="copy-btn"
            onClick={onCopy}
            title="Copy the selection, or what is on screen (Ctrl+Shift+C)"
          >
            Copy
          </button>
          <button
            type="button"
            className="copy-btn"
            onClick={onCopyAll}
            title="Copy the whole transcript, including scrollback"
          >
            Copy all
          </button>
          {activeSession.status === 'running' ? (
            <button type="button" className="kill-btn" onClick={onKillSession}>
              Kill Session
            </button>
          ) : (
            <button type="button" className="remove-btn" onClick={onRemoveSession}>
              Remove
            </button>
          )}
        </div>
      </div>
      <div className="output-container" ref={outputContainerRef}>
        <RawTerminal
          ref={terminalRef}
          onSendInput={onSendInput}
          onInterrupt={onKillSession}
          onResize={onTerminalResize}
          colorScheme={colorScheme}
          fontSize={terminalFontSize}
          disabled={activeSession.status !== 'running'}
        />
      </div>
      {showDebugBar ? (
        <div className="debug-info" data-testid="debug-info">
          Debug: chars: {charCount}, active: {activeSession.id || 'none'}, WS raw_data:{' '}
          {wsMessageCount}, session_updates: {sessionUpdateCount}
        </div>
      ) : null}
    </>
  )
}

export function App() {
  const [sessions, setSessions] = useState<PTYSessionInfo[]>([])
  const [parentSessionTitles, setParentSessionTitles] = useState<Record<string, string>>({})
  const [activeSession, setActiveSession] = useState<PTYSessionInfo | null>(null)
  const [wsMessageCount, setWsMessageCount] = useState(0)
  const [sessionUpdateCount, setSessionUpdateCount] = useState(0)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [docsOpen, setDocsOpen] = useState(false)

  const { preference: themePreference, scheme, setPreference: setThemePreference } = useTheme()
  const { prefs, setTerminalFontSize, setShowDebugBar } = useUiPrefs()

  const appShellRef = useRef<HTMLDivElement>(null)
  const settingsButtonRef = useRef<HTMLButtonElement>(null)
  const docsButtonRef = useRef<HTMLButtonElement>(null)

  const terminalRef = useRef<RawTerminal>(null)
  const [copyFeedback, setCopyFeedback] = useState('')
  // Fetched, not baked into the bundle: the bundle is built once, but the server
  // it is talking to is whatever is listening, and a stale bundle next to a fresh
  // server would report a commit that is not running.
  const [buildInfo, setBuildInfo] = useState<BuildInfo | null>(null)
  const copyFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let cancelled = false
    const hasParentSession = sessions.some((session) => Boolean(session.parentSessionId))
    if (!hasParentSession) {
      setParentSessionTitles({})
      return
    }

    void api.parentSessions
      .list()
      .then((response) => {
        if (!cancelled) setParentSessionTitles(response.titles)
      })
      .catch((error) => console.error('Failed to load parent session titles', error))

    return () => {
      cancelled = true
    }
  }, [sessions])

  const handleSessionRemoved = useCallback((sessionId: string) => {
    setSessions((prevSessions) => prevSessions.filter((session) => session.id !== sessionId))
    setActiveSession((current) => (current?.id === sessionId ? null : current))
  }, [])

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

  useEffect(() => {
    let cancelled = false
    void api
      .server()
      .then((info) => {
        if (!cancelled) setBuildInfo(info.build)
      })
      .catch(() => {
        // A failed lookup leaves the row on "Checking…". Erroring loudly in a
        // settings dialog the user opened to change their font size would be
        // worse than a missing version, and the same value is on /api/server.
      })
    return () => {
      cancelled = true
    }
  }, [])

  const showCopyFeedback = useCallback((message: string) => {
    setCopyFeedback(message)
    if (copyFeedbackTimerRef.current) {
      clearTimeout(copyFeedbackTimerRef.current)
    }
    copyFeedbackTimerRef.current = setTimeout(() => setCopyFeedback(''), 2500)
  }, [])

  useEffect(
    () => () => {
      if (copyFeedbackTimerRef.current) {
        clearTimeout(copyFeedbackTimerRef.current)
      }
    },
    []
  )

  const reportCopy = useCallback(
    async (text: string, emptyLabel: string, doneLabel: string) => {
      if (!text) {
        showCopyFeedback(emptyLabel)
        return
      }
      const copied = await copyTextToClipboard(text)
      const lineCount = text.split('\n').length
      showCopyFeedback(
        copied ? `${doneLabel} ${lineCount} line${lineCount === 1 ? '' : 's'}` : 'Copy failed'
      )
    },
    [showCopyFeedback]
  )

  /** Selection if there is one, otherwise what is on screen. */
  const handleCopy = useCallback(async () => {
    const text = terminalRef.current?.getCopyText() ?? ''
    await reportCopy(text, 'Nothing to copy', 'Copied')
  }, [reportCopy])

  /** The whole transcript, including what the emulator no longer holds. */
  const handleCopyAll = useCallback(async () => {
    const sessionId = activeSessionIdRef.current
    if (!sessionId) return
    try {
      const data = await api.session.buffer.plain({ id: sessionId })
      await reportCopy(data.plain ?? '', 'Nothing to copy', 'Copied all')
    } catch (error) {
      console.error('Failed to copy the session transcript', error)
      showCopyFeedback('Copy failed')
    }
  }, [reportCopy, showCopyFeedback])

  // Ctrl+Shift+C - and Cmd+C, where that is the platform convention - copy the
  // terminal. Plain Ctrl+C is left alone so it keeps sending SIGINT.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'KeyC' || !(event.metaKey || (event.ctrlKey && event.shiftKey))) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      void handleCopy()
    }

    document.addEventListener('keydown', onKeyDown, { capture: true })
    return () => document.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [handleCopy])

  // Ctrl+, / Cmd+, open the settings dialog. Capture phase so the shortcut wins
  // even while the terminal canvas has focus.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== ',' || !(event.metaKey || event.ctrlKey)) {
        return
      }
      event.preventDefault()
      setSettingsOpen(true)
    }

    document.addEventListener('keydown', onKeyDown, { capture: true })
    return () => document.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [])

  // Ctrl+/ or Cmd+/ opens the documentation dialog. The settings dialog wins
  // ties so a stray slash does not stack a second dialog on top of it.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '/' || !(event.metaKey || event.ctrlKey) || settingsOpen) {
        return
      }
      event.preventDefault()
      setDocsOpen(true)
    }

    document.addEventListener('keydown', onKeyDown, { capture: true })
    return () => document.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [settingsOpen])

  // Session pushes arrive over the WebSocket; a tab that was suspended (or whose
  // socket went half-open) would otherwise keep a stale list, because the old
  // periodic poll is gone. Refresh whenever the tab becomes visible again.
  useEffect(() => {
    const sync = () => {
      if (document.visibilityState !== 'visible') return
      api.sessions
        .list()
        .then((sessions) => setSessions(sortSessionsByTime(sessions)))
        .catch((error) => console.error('Failed to resync sessions', error))
    }

    document.addEventListener('visibilitychange', sync)
    window.addEventListener('focus', sync)
    return () => {
      document.removeEventListener('visibilitychange', sync)
      window.removeEventListener('focus', sync)
    }
  }, [])

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
        setSessions(sortSessionsByTime(newSessions))
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
        const next =
          existingIndex >= 0
            ? prevSessions.map((session) =>
                session.id === updatedSession.id ? updatedSession : session
              )
            : [...prevSessions, updatedSession]
        // Keep the list ordered the same way the server does: a session that
        // just finished moves up to "most recent activity".
        return sortSessionsByTime(next)
      })
    }, []),
    onSessionRemoved: handleSessionRemoved,
  })

  const { outputContainerRef, handleTerminalResize } = useTerminalResize({
    activeSession,
    connected: wsConnected,
    sendResize,
    terminalRef,
  })

  const {
    handleSessionClick,
    handleSendInput,
    handleKillSession,
    handleKillSessionById,
    handleRemoveSession,
  } = useSessionManager({
    activeSession,
    setActiveSession,
    subscribeWithRetry,
    sendInput,
    wsConnected,
    onSessionReset: resetRawStream,
    onSnapshot: applySnapshot,
    getSinceOffset: getOffset,
  })

  const removeSessionFromList = handleSessionRemoved

  // The confirmation is a two-step on purpose: the plan is computed from the
  // list the reader is looking at, then the ids are sent as they were picked.
  // Recomputing the plan after the call would report what happened as what was
  // agreed to.
  const [removalPlan, setRemovalPlan] = useState<{
    ids: string[]
    removable: number
    stoppable: number
    hiddenByFilter: number
  } | null>(null)
  const [undoState, setUndoState] = useState<{ count: number; ids: string[] } | null>(null)

  const startRemoval = useCallback(
    (ids: string[], hiddenByFilter: number) => {
      const stoppable = ids.filter((id) => {
        const session = sessions.find((candidate) => candidate.id === id)
        return session !== undefined && isLiveStatus(session.status)
      }).length
      setRemovalPlan({
        ids,
        removable: ids.length - stoppable,
        stoppable,
        hiddenByFilter,
      })
    },
    [sessions]
  )

  const cancelRemoval = useCallback(() => setRemovalPlan(null), [])

  const confirmRemoval = useCallback(async () => {
    const plan = removalPlan
    if (!plan) return
    setRemovalPlan(null)
    try {
      const result = await api.sessions.bulkRemove({ ids: plan.ids })
      const gone = [...result.removed, ...result.killed]
      setSessions((previous) => previous.filter((session) => !gone.includes(session.id)))
      setActiveSession((current) => (current && gone.includes(current.id) ? null : current))
      // Undo offers back exactly what came back as restorable. A stopped session
      // reappears as an empty row, so offering Undo for it and then producing
      // nothing would be worse than not offering it.
      setUndoState({ count: gone.length, ids: result.removed })
    } catch (error) {
      console.error('Failed to remove selected sessions', error)
    }
  }, [removalPlan])

  const undoRemoval = useCallback(async () => {
    const pending = undoState
    if (!pending || pending.ids.length === 0) return
    try {
      await api.sessions.restore({ ids: pending.ids })
      // Refetch rather than reinserting: a restored session's metadata has to
      // come from the store, and inventing it here would be how a restored row
      // ends up with the wrong exit code.
      const refreshed = await api.sessions.list()
      setSessions(refreshed)
      setUndoState(null)
    } catch (error) {
      console.error('Failed to restore removed sessions', error)
    }
  }, [undoState])

  const dismissUndo = useCallback(() => setUndoState(null), [])

  /**
   * `Clear finished` is the same action as a selection of every finished
   * session, so it goes through the same dialog and the same undo. The old
   * native `confirm()` named a count and nothing else, and it fired one request
   * per session.
   */
  const handleClearFinishedClick = useCallback(() => {
    const finishedIds = sessions
      .filter((session) => !isLiveStatus(session.status))
      .map((session) => session.id)
    startRemoval(finishedIds, 0)
  }, [sessions, startRemoval])

  const handleRemoveSessionClick = useCallback(
    async (session: PTYSessionInfo) => {
      const removed = await handleRemoveSession(session)
      if (removed) {
        removeSessionFromList(session.id)
      }
    },
    [handleRemoveSession, removeSessionFromList]
  )

  return (
    <>
      <div className="container" ref={appShellRef} data-active-session={activeSession?.id}>
        <Sidebar
          sessions={sessions}
          parentSessionTitles={parentSessionTitles}
          activeSession={activeSession}
          onSessionClick={handleSessionClick}
          onKillSession={handleKillSessionById}
          onRemoveSession={handleRemoveSessionClick}
          onClearFinished={handleClearFinishedClick}
          onRemoveSelection={startRemoval}
          connected={wsConnected}
          themePreference={themePreference}
          onThemePreferenceChange={setThemePreference}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenDocs={() => setDocsOpen(true)}
          docsButtonRef={docsButtonRef}
          settingsButtonRef={settingsButtonRef}
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
              colorScheme={scheme}
              terminalFontSize={prefs.terminalFontSize}
              showDebugBar={prefs.showDebugBar}
              copyFeedback={copyFeedback}
              onCopy={handleCopy}
              onCopyAll={handleCopyAll}
              onTerminalResize={handleTerminalResize}
              onSendInput={handleSendInput}
              onKillSession={handleKillSession}
              onRemoveSession={() => handleRemoveSessionClick(activeSession)}
            />
          ) : (
            <div className="empty-state">Select a session from the sidebar to view its output</div>
          )}
        </div>
      </div>
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        returnFocusRef={settingsButtonRef}
        inertTarget={appShellRef}
        themePreference={themePreference}
        onThemePreferenceChange={setThemePreference}
        terminalFontSize={prefs.terminalFontSize}
        onTerminalFontSizeChange={setTerminalFontSize}
        showDebugBar={prefs.showDebugBar}
        onShowDebugBarChange={setShowDebugBar}
        buildInfo={buildInfo}
      />
      <DocsModal
        open={docsOpen}
        onClose={() => setDocsOpen(false)}
        returnFocusRef={docsButtonRef}
        inertTarget={appShellRef}
      />
      <RemoveSessionsDialog
        open={removalPlan !== null}
        plan={{
          removable: removalPlan?.removable ?? 0,
          stoppable: removalPlan?.stoppable ?? 0,
          hiddenByFilter: removalPlan?.hiddenByFilter ?? 0,
        }}
        confirmLabel={removalPlan?.stoppable ? 'Stop and remove' : 'Remove'}
        onConfirm={() => void confirmRemoval()}
        onClose={cancelRemoval}
      />
      <UndoToast
        count={undoState?.count ?? 0}
        restorable={undoState?.ids.length ?? 0}
        onUndo={() => void undoRemoval()}
        onDismiss={dismissUndo}
      />
    </>
  )
}
