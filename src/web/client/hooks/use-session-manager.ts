import { useCallback } from 'react'
import type { PTYSessionInfo } from 'opencode-pty/web/shared/types'

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
        // eslint-disable-next-line no-empty
      } catch {}
    },
    [activeSession, wsConnected, sendInput]
  )

  const handleKillSession = useCallback(async () => {
    if (!activeSession) {
      return
    }

    if (
      !confirm(
        `Are you sure you want to kill session "${activeSession.description ?? activeSession.title}"?`
      )
    ) {
      return
    }

    try {
      await api.session.kill({ id: activeSession.id })

      // eslint-disable-next-line no-empty
    } catch {}
  }, [activeSession])

  return {
    handleSessionClick,
    handleSendInput,
    handleKillSession,
  }
}
