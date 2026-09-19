import type { ITerminalCore } from 'ghostty-web'
import type { IBuffer, TerminalBuffers } from './types.ts'

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null
}

const isBuffer = (value: unknown): value is IBuffer => {
  if (!isRecord(value)) return false
  if (typeof value.length !== 'number') return false
  if (typeof value.cursorX !== 'number') return false
  if (typeof value.cursorY !== 'number') return false
  if (typeof value.baseY !== 'number') return false
  if (typeof value.viewportY !== 'number') return false
  if (typeof value.getLine !== 'function') return false
  if (typeof value.getNullCell !== 'function') return false
  return true
}

export const getTerminalBuffers = (value: ITerminalCore): TerminalBuffers | undefined => {
  if (!isRecord(value)) return
  const raw = value.buffer
  if (!isRecord(raw)) return
  const active = isBuffer(raw.active) ? raw.active : undefined
  const normal = isBuffer(raw.normal) ? raw.normal : undefined
  const alternate = isBuffer(raw.alternate) ? raw.alternate : undefined
  if (!active && !normal) return
  return { active, normal, alternate }
}

export const getTerminalMode = (value: ITerminalCore, mode: number): boolean => {
  if (!isRecord(value)) return false
  const terminal = value.wasmTerm
  if (!isRecord(terminal) || typeof terminal.getMode !== 'function') return false
  return terminal.getMode(mode) === true
}
