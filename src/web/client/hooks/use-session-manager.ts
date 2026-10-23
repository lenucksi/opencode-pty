import type { PTYSessionInfo } from 'opencode-pty/web/shared/types'
import { useCallback } from 'react'

import { api } from '../../shared/api-client'

interface UseSessionManagerOptions {
  activeSession: PTYSessionInfo | null
  setActiveSession: (session: PTYSessionInfo | null) => void
  subscribeWithRetry: (sessionId: string) => void
  sendInput?: (sessionId: string, data: string) => void
  wsConnected?: boolean
  onSessionReset?: () => void
  onSnapshot?: (snapshot: { raw: string; offset: number }) => void
  getSinceOffset?: () => number
  /**
   * Where a failure goes.
   *
   * A write that did not reach the process, or a removal the server refused, is not
   * visible in the page: it looks exactly like one where the action worked. The
   * caller decides how loud to be.
   */
  onError?: (message: string) => void
}

function sessionLabel(session: PTYSessionInfo): string {
  return session.description ?? session.title
}

export function useSessionManager({
  activeSession,
  setActiveSession,
  subscribeWithRetry,
  sendInput,
  wsConnected,
  onSessionReset,
  onSnapshot,
  getSinceOffset,
  onError,
}: UseSessionManagerOptions) {
  const handleSessionClick = useCallback(
    async (session: PTYSessionInfo) => {
      try {
        // Validate session object first
        if (!session?.id) {
          return
        }
        setActiveSession(session)
        onSessionReset?.()
        // Subscribe to this session before fetching the snapshot so no chunk
        // produced in between can be lost.
        subscribeWithRetry(session.id)

        const since = getSinceOffset?.() ?? 0
        try {
          const rawData = await api.session.buffer.raw({ id: session.id, since })
          onSnapshot?.({ raw: rawData.raw || '', offset: rawData.offset })
        } catch {
          // Keep whatever the WebSocket stream already delivered.
        }
      } catch {
        // Ensure UI remains stable
        onSessionReset?.()
      }
    },
    [setActiveSession, subscribeWithRetry, onSessionReset, onSnapshot, getSinceOffset]
  )

  const handleSendInput = useCallback(
    async (data: string) => {
      if (!data || !activeSession) {
        return
      }

      // Try WebSocket first if connected and available
      if (wsConnected && sendInput) {
        try {
          sendInput(activeSession.id, data)
          return
        } catch (error) {
          console.warn('WebSocket input failed, falling back to HTTP:', error)
        }
      }

      // HTTP fallback
      try {
        await api.session.input({ id: activeSession.id }, { data })
      } catch (error) {
        console.error('Failed to send input', error)
        onError?.('The input was not sent.')
      }
    },
    [activeSession, wsConnected, sendInput, onError]
  )

  /**
   * Kills a running session. The session is retained (with its buffer) so the
   * transcript stays available; removing it is a human action in the web UI.
   */
  const handleKillSessionById = useCallback(
    async (session: PTYSessionInfo): Promise<boolean> => {
      if (!confirm(`Are you sure you want to kill session "${sessionLabel(session)}"?`)) {
        return false
      }

      try {
        await api.session.kill({ id: session.id })
        return true
      } catch (error) {
        console.error('Failed to kill session', error)
        onError?.(`Could not stop ${sessionLabel(session)}.`)
        return false
      }
    },
    [onError]
  )

  const handleKillSession = useCallback(async () => {
    if (!activeSession) {
      return
    }
    await handleKillSessionById(activeSession)
  }, [activeSession, handleKillSessionById])

  /**
   * Human-only: discards a finished session entirely (buffer freed, dropped
   * from the session list).
   */
  const handleRemoveSession = useCallback(
    async (session: PTYSessionInfo): Promise<boolean> => {
      if (
        !confirm(
          `Remove finished session "${sessionLabel(session)}"? Its output buffer will be discarded.`
        )
      ) {
        return false
      }

      try {
        await api.session.cleanup({ id: session.id })
        return true
      } catch (error) {
        console.error('Failed to remove session', error)
        onError?.(`Could not remove ${sessionLabel(session)}.`)
        return false
      }
    },
    [onError]
  )

  return {
    handleSessionClick,
    handleSendInput,
    handleKillSession,
    handleKillSessionById,
    handleRemoveSession,
  }
}
