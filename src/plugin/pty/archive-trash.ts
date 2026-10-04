import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { META_FILE, TRASH_DIR } from './archive-files.ts'
import { logPtyEvent } from './plugin-log.ts'
import type { PersistedSession } from './session-store.ts'

/**
 * Moving a session out of the way, and back.
 *
 * A removal destroys the only record of what a process printed, and the buffer
 * is what a bug report is written from, so `moveToTrash` renames rather than
 * deletes. The window is bounded by construction rather than by a timer:
 * `emptyTrash` runs before anything else at startup, so nothing is restorable
 * across a restart - which is the span in which a mistake is noticed anyway.
 *
 * Plain functions over a root directory, because none of this needs the store's
 * index. The store keeps the bookkeeping and delegates the file system.
 */

/**
 * Move a session into the trash.
 *
 * Returns false when the directory was not there, which is not an error: a
 * caller asked for something that had already gone.
 */
export function moveToTrash(root: string, id: string): boolean {
  try {
    mkdirSync(trashRoot(root), { recursive: true, mode: 0o700 })
    renameSync(join(root, id), join(trashRoot(root), id))
    return true
  } catch (error) {
    logPtyEvent('error', `failed to remove archived session ${id}`, error)
    return false
  }
}

/**
 * Put a removed session back.
 *
 * Returns the metadata the archive carried, read out of the trashed `meta.json`
 * rather than remembered, so a restore cannot invent an index entry the archive
 * did not have. A directory without readable metadata is still restored; it just
 * does not rejoin the index.
 */
export function restoreFromTrash(root: string, id: string): PersistedSession | null {
  const source = join(trashRoot(root), id)
  if (!existsSync(source)) return null
  const target = join(root, id)
  try {
    renameSync(source, target)
  } catch (error) {
    logPtyEvent('error', `failed to restore session ${id}`, error)
    return null
  }
  return readMeta(target)
}

/** Ids that can still be restored. */
export function listTrash(root: string): string[] {
  try {
    return readdirSync(trashRoot(root), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

/** Empty the trash. Returns how many sessions went with it. */
export function emptyTrash(root: string): number {
  const ids = listTrash(root)
  try {
    rmSync(trashRoot(root), { recursive: true, force: true })
  } catch (error) {
    logPtyEvent('error', 'failed to empty the session trash', error)
    return 0
  }
  return ids.length
}

/** Remove without keeping a copy. */
export function removeArchive(root: string, id: string): boolean {
  try {
    rmSync(join(root, id), { recursive: true, force: true })
    return true
  } catch (error) {
    logPtyEvent('error', `failed to purge archived session ${id}`, error)
    return false
  }
}

/**
 * Inside `root` rather than beside it: the store may not be able to write to the
 * parent, since `state-paths` puts the state directory wherever `XDG_STATE_HOME`
 * points and a sibling of that is not necessarily ours.
 */
function trashRoot(root: string): string {
  return join(root, TRASH_DIR)
}

/** The metadata a session directory carries, or null when it has none. */
function readMeta(dir: string): PersistedSession | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, META_FILE), 'utf8'))
    if (parsed && typeof parsed === 'object' && 'id' in parsed) {
      return parsed as PersistedSession
    }
  } catch {
    // Restored anyway; it just stays out of the list until something reindexes it.
  }
  return null
}
