import { type RefObject, useCallback, useEffect, useRef, useState } from 'react'

import { api } from '../../shared/api-client.ts'
import { copyTextToClipboard } from '../lib/clipboard.ts'
import type { RawTerminal } from '../components/terminal-renderer.tsx'

/**
 * The copy feedback line and the two things that fill it.
 *
 * Owns the timer that clears the message, so a caller cannot leave one running
 * past unmount, and keeps "selection if there is one, otherwise the screen" and
 * "the whole transcript" from drifting apart.
 */
export function useCopyFeedback(
  activeSessionId: string | null,
  terminalRef: RefObject<RawTerminal | null>
) {
  const [copyFeedback, setCopyFeedback] = useState('')
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const show = useCallback((message: string) => {
    setCopyFeedback(message)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setCopyFeedback(''), 2500)
  }, [])

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    },
    []
  )

  const report = useCallback(
    async (text: string, emptyLabel: string, doneLabel: string) => {
      if (!text) {
        show(emptyLabel)
        return
      }
      const copied = await copyTextToClipboard(text)
      const lineCount = text.split('\n').length
      show(copied ? `${doneLabel} ${lineCount} line${lineCount === 1 ? '' : 's'}` : 'Copy failed')
    },
    [show]
  )

  /** Selection if there is one, otherwise what is on screen. */
  const handleCopy = useCallback(async () => {
    const text = terminalRef.current?.getCopyText() ?? ''
    await report(text, 'Nothing to copy', 'Copied')
  }, [report, terminalRef])

  /** The whole transcript, including what the emulator no longer holds. */
  const handleCopyAll = useCallback(async () => {
    if (!activeSessionId) return
    try {
      const data = await api.session.buffer.plain({ id: activeSessionId })
      await report(data.plain ?? '', 'Nothing to copy', 'Copied all')
    } catch (error) {
      console.error('Failed to copy the session transcript', error)
      show('Copy failed')
    }
  }, [activeSessionId, report, show])

  return { copyFeedback, handleCopy, handleCopyAll }
}
