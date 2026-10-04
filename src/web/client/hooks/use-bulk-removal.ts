import { useCallback, useState } from 'react'

import type { PTYSessionInfo } from 'opencode-pty/web/shared/types'

import { api } from '../../shared/api-client.ts'

/** What a confirmation has to name before anything is removed. */
export interface RemovalPlan {
  ids: string[]
  /** Finished sessions: their output moves to the trash and can be restored. */
  removable: number
  /** Running sessions: stopped, and their output is not recoverable. */
  stoppable: number
  /** How many selected sessions the current search hides. */
  hiddenByFilter: number
}

/** What an undo can offer back, which is not every id that was removed. */
export interface UndoState {
  count: number
  ids: string[]
}

interface UseBulkRemovalOptions {
  sessions: PTYSessionInfo[]
  onRemoved: (ids: string[]) => void
  onRestored: (sessions: PTYSessionInfo[]) => void
}

interface UseBulkRemoval {
  plan: RemovalPlan | null
  undo: UndoState | null
  /** Open the confirmation for these ids, naming the two kinds of consequence. */
  requestRemoval: (ids: string[], hiddenByFilter: number) => void
  cancelRemoval: () => void
  confirmRemoval: () => Promise<void>
  undoRemoval: () => Promise<void>
  dismissUndo: () => void
}

/** A session is live until its process has actually exited. */
function isLiveStatus(status: PTYSessionInfo['status']): boolean {
  return status === 'running' || status === 'killing'
}

/**
 * The removal flow: plan, confirm, remove, offer the undo.
 *
 * Split out of `App` because it is one concern with its own state, and `App` had
 * grown past the point where a second reader could hold all of it in their head.
 *
 * The plan is built from the session list the reader is looking at and sent as
 * the ids were picked. Recomputing the plan after the call would report what
 * happened as what was agreed to.
 */
export function useBulkRemoval({
  sessions,
  onRemoved,
  onRestored,
}: UseBulkRemovalOptions): UseBulkRemoval {
  const [plan, setPlan] = useState<RemovalPlan | null>(null)
  const [undo, setUndo] = useState<UndoState | null>(null)

  const requestRemoval = useCallback(
    (ids: string[], hiddenByFilter: number) => {
      const stoppable = ids.filter((id) => {
        const session = sessions.find((candidate) => candidate.id === id)
        return session !== undefined && isLiveStatus(session.status)
      }).length
      setPlan({ ids, removable: ids.length - stoppable, stoppable, hiddenByFilter })
    },
    [sessions]
  )

  const cancelRemoval = useCallback(() => setPlan(null), [])

  const confirmRemoval = useCallback(async () => {
    const current = plan
    if (!current) return
    setPlan(null)
    try {
      const result = await api.sessions.bulkRemove({ ids: current.ids })
      const gone = [...result.removed, ...result.killed]
      onRemoved(gone)
      // Undo offers back exactly what came back restorable. A stopped session
      // reappears as an empty row, so offering Undo for it and then producing
      // nothing would be worse than not offering it.
      setUndo({ count: gone.length, ids: result.removed })
    } catch (error) {
      console.error('Failed to remove selected sessions', error)
    }
  }, [plan, onRemoved])

  const undoRemoval = useCallback(async () => {
    const pending = undo
    if (!pending || pending.ids.length === 0) return
    try {
      const result = await api.sessions.restore({ ids: pending.ids })
      // Refetch rather than reinserting: a restored session's metadata has to
      // come from the store, and inventing it here is how a restored row ends up
      // with the wrong exit code.
      const refreshed = await api.sessions.list()
      onRestored(refreshed)
      setUndo(result.failed.length > 0 ? { ...pending, ids: result.failed } : null)
    } catch (error) {
      console.error('Failed to restore removed sessions', error)
    }
  }, [undo, onRestored])

  const dismissUndo = useCallback(() => setUndo(null), [])

  return {
    plan,
    undo,
    requestRemoval,
    cancelRemoval,
    confirmRemoval,
    undoRemoval,
    dismissUndo,
  }
}
