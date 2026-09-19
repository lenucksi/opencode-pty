import { useCallback, useEffect, useRef, useState } from 'react'
import {
  RawStream,
  type ChunkResult,
  type RawChunk,
  type RawSnapshot,
  type RenderIntent,
} from '../lib/raw-stream.ts'

/**
 * Owns the reconciliation state for the active session and pushes render
 * intents (deltas/rewrites/resets) straight to the terminal emulator. Only
 * scalar counters live in React state, never the transcript itself.
 */
export function useRawStream(onRender?: (intent: RenderIntent) => void) {
  const streamRef = useRef(new RawStream())
  const [charCount, setCharCount] = useState(0)

  // Keep the latest render sink without letting its identity churn the
  // callbacks below (which would otherwise reconnect the WebSocket).
  const onRenderRef = useRef(onRender)
  useEffect(() => {
    onRenderRef.current = onRender
  }, [onRender])

  const emitRender = useCallback(() => {
    const intent = streamRef.current.render
    if (intent.type !== 'none') {
      onRenderRef.current?.(intent)
    }
  }, [])

  const reset = useCallback(() => {
    streamRef.current.reset()
    emitRender()
    setCharCount(0)
  }, [emitRender])

  const applyChunk = useCallback(
    (chunk: RawChunk): ChunkResult => {
      const result = streamRef.current.applyChunk(chunk)
      if (result === 'applied') {
        emitRender()
        setCharCount(streamRef.current.value.length)
      }
      return result
    },
    [emitRender]
  )

  const applySnapshot = useCallback(
    (snapshot: RawSnapshot) => {
      streamRef.current.applySnapshot(snapshot)
      emitRender()
      setCharCount(streamRef.current.value.length)
    },
    [emitRender]
  )

  const getOffset = useCallback(() => streamRef.current.offset, [])

  return { reset, applyChunk, applySnapshot, getOffset, charCount }
}
