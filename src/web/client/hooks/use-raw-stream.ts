import { useCallback, useRef, useState } from 'react'
import { RawStream, type ChunkResult, type RawChunk, type RawSnapshot } from '../lib/raw-stream.ts'

/**
 * Owns the rendered raw output for the active session and reconciles the
 * WebSocket delta stream against HTTP snapshots using monotonic offsets.
 */
export function useRawStream() {
  const [rawOutput, setRawOutput] = useState('')
  const streamRef = useRef(new RawStream())

  const reset = useCallback(() => {
    streamRef.current.reset()
    setRawOutput('')
  }, [])

  const applyChunk = useCallback((chunk: RawChunk): ChunkResult => {
    const result = streamRef.current.applyChunk(chunk)
    if (result === 'applied') {
      setRawOutput(streamRef.current.value)
    }
    return result
  }, [])

  const applySnapshot = useCallback((snapshot: RawSnapshot) => {
    streamRef.current.applySnapshot(snapshot)
    setRawOutput(streamRef.current.value)
  }, [])

  const getOffset = useCallback(() => streamRef.current.offset, [])

  return { rawOutput, reset, applyChunk, applySnapshot, getOffset }
}
