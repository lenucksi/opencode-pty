/**
 * What a session directory contains.
 *
 * Its own module because two readers need the names and one of them is imported
 * by the store: putting them in the store would make that import circular, and
 * duplicating two string literals means a rename silently splits them.
 */
export const META_FILE = 'meta.json'
export const LOG_FILE = 'output.log'
/** The log a session rolled over from, read before the current one. */
export const PREVIOUS_LOG_FILE = 'output.log.1'
export const INDEX_FILE = 'index.json'
/**
 * Where removed sessions wait. Cannot collide with a session id, which is `pty_`
 * plus eight hex digits.
 */
export const TRASH_DIR = '.trash'
