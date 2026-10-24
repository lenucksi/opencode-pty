/**
 * Reads a file's contents, or `null` when it is missing or unreadable.
 *
 * A type rather than a function so each reader keeps its own error handling
 * (the build identity degrades to "unknown", the notice list to `available:
 * false`) while both stay substitutable in tests.
 */
export type FileReader = (path: string) => string | null
