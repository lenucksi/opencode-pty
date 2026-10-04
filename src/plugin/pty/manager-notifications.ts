/**
 * The fan-out from the manager to whoever is listening.
 *
 * Three channels: raw output as a session produces it, a session's metadata
 * changing, and a session going away. All three are lists of callbacks that the
 * manager pushes to, and none of them needs any manager state - which is why they
 * are here rather than in the manager, whose own file is long enough.
 *
 * Every callback is wrapped in a try. A listener that throws is one consumer's
 * problem and must not stop the others from being told, and it must not take the
 * PTY layer down either.
 */

import type { PTYSessionInfo } from './types.ts'

export type RawOutputCallback = (sessionId: string, rawData: string, offset: number) => void
export type SessionUpdateCallback = (session: PTYSessionInfo) => void
export type SessionRemovedCallback = (sessionId: string) => void

export const rawOutputCallbacks: RawOutputCallback[] = []
export const sessionUpdateCallbacks: SessionUpdateCallback[] = []
export const sessionRemovedCallbacks: SessionRemovedCallback[] = []

export function registerRawOutputCallback(callback: RawOutputCallback): void {
  rawOutputCallbacks.push(callback)
}

export function removeRawOutputCallback(callback: RawOutputCallback): void {
  const index = rawOutputCallbacks.indexOf(callback)
  if (index !== -1) {
    rawOutputCallbacks.splice(index, 1)
  }
}

export function registerSessionUpdateCallback(callback: SessionUpdateCallback): void {
  sessionUpdateCallbacks.push(callback)
}

export function removeSessionUpdateCallback(callback: SessionUpdateCallback): void {
  const index = sessionUpdateCallbacks.indexOf(callback)
  if (index !== -1) {
    sessionUpdateCallbacks.splice(index, 1)
  }
}

export function registerSessionRemovedCallback(callback: SessionRemovedCallback): void {
  sessionRemovedCallbacks.push(callback)
}

export function removeSessionRemovedCallback(callback: SessionRemovedCallback): void {
  const index = sessionRemovedCallbacks.indexOf(callback)
  if (index !== -1) {
    sessionRemovedCallbacks.splice(index, 1)
  }
}

/** Every callback runs, even if an earlier one threw. */
function fanOut<T>(callbacks: T[], invoke: (callback: T) => void): void {
  for (const callback of callbacks) {
    try {
      invoke(callback)
    } catch {
      // Ignore callback errors
    }
  }
}

export function notifyRawOutput(sessionId: string, rawData: string, offset: number): void {
  // The copy is load-bearing: a listener may deregister itself from inside the
  // call, so walking the live array would skip the element behind the removed one.
  // aislop-ignore-next-line unicorn/no-useless-spread -- a callback deregisters itself while being notified
  fanOut([...rawOutputCallbacks], (callback) => callback(sessionId, rawData, offset))
}

export function notifySessionUpdate(session: PTYSessionInfo): void {
  // The copy is load-bearing, as in notifyRawOutput above.
  // aislop-ignore-next-line unicorn/no-useless-spread -- a callback deregisters itself while being notified
  fanOut([...sessionUpdateCallbacks], (callback) => callback(session))
}

export function notifySessionRemoved(sessionId: string): void {
  // A removal can be triggered from inside a session update, so this one walks a
  // snapshot for the same reason.
  // aislop-ignore-next-line unicorn/no-useless-spread -- removal can be triggered from inside an update callback
  fanOut([...sessionRemovedCallbacks], (callback) => callback(sessionId))
}
