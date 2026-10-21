/**
 * Row identity across polls.
 *
 * Every poll hands the views a list the server just built, so identical content arrives
 * as new objects. Handing a store a whole new array makes whatever watches it treat
 * every row as changed - the twitch a reader sees as the list reloading. A row whose
 * fields did not move keeps its object identity, and a list where nothing moved keeps
 * the array.
 *
 * Shared by the sidebar and the panel, because both re-read the same list on the same
 * tick and both used to rebuild it.
 */

import type { PanelSession } from './lib.ts'

/**
 * The rows the panel is already showing, carried over into the fresh list when they are
 * the same content.
 *
 * Every poll hands this a list the SERVER just built, so identical content arrives as
 * new objects; handing the store a whole new array makes whatever watches it treat
 * every row as changed, which is the twitch the reader measured once a panel was
 * scrolled. A row whose fields did not move keeps its object identity, and a list where
 * nothing moved keeps... the array: only what changed is asked to change.
 */
export function mergeIdentical(
  incoming: PanelSession[],
  shown: readonly PanelSession[]
): PanelSession[] {
  const byId = new Map(shown.map((session) => [session.id, session]))
  let changed = incoming.length !== shown.length
  const merged = incoming.map((session) => {
    const before = byId.get(session.id)
    if (before !== undefined && samePanelSession(before, session)) return before
    changed = true
    return session
  })
  // Ordering is part of the content too: the same rows in a different order are rows a
  // watcher has to see as moved. The comparison runs against what was SHOWN, because
  // `merged` deliberately carries the prior objects where the content matched - and a
  // position against the fresh input would read "changed" for identical content.
  if (!changed) {
    for (let i = 0; i < incoming.length; i++) {
      const current = merged[i]
      const prior = shown[i]
      if (current !== undefined && prior !== undefined && current !== prior) {
        changed = true
        break
      }
    }
  }
  return changed ? merged : (shown as PanelSession[])
}

/**
 * Whether two records agree on everything the panel shows: the fields a watcher reads,
 * compared by value so a re-serialized record does not count as a change.
 */
export function samePanelSession(
  a: PanelSession | undefined,
  b: PanelSession | undefined
): boolean {
  if (a === undefined || b === undefined) return a === undefined && b === undefined
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])]
  return keys.every((key) => (a as never)[key] === (b as never)[key])
}

/** Whether two lists are pairwise the same objects, length included. */
export function sameGroup(a: readonly PanelSession[], b: readonly PanelSession[]): boolean {
  return a.length === b.length && a.every((session, index) => session === b[index])
}
