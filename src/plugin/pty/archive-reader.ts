import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { BoundedReadResult, BoundedSearchResult } from './output-manager.ts'
import { LOG_FILE, PREVIOUS_LOG_FILE } from './archive-files.ts'
import { logPtyEvent } from './plugin-log.ts'
import { applyLineBudget } from './read-budget.ts'

/**
 * Reading an archived transcript.
 *
 * Kept apart from `SessionStore` because it needs none of the store's state. It
 * is handed a directory and answers from what is in it, which is also what makes
 * it obvious that the archived path and the live path share the same budget
 * instead of reimplementing it.
 */

/** The stored output of one session, or null when the directory is not there. */
export function readArchiveRaw(dir: string, id: string): string | null {
  if (!existsSync(dir)) return null

  let text = ''
  // Two files, oldest first: a session that rolled over keeps its earlier lines,
  // and dropping them would silently truncate what the reader is shown.
  for (const file of [PREVIOUS_LOG_FILE, LOG_FILE]) {
    const path = join(dir, file)
    try {
      if (existsSync(path)) text += readFileSync(path, 'utf8')
    } catch (error) {
      logPtyEvent('warn', `failed to read archived output of ${id}`, error)
    }
  }
  return text
}

/** All archived lines, or null when the session is unknown. */
export function archiveLines(dir: string, id: string): string[] | null {
  const raw = readArchiveRaw(dir, id)
  if (raw === null) return null

  const lines = raw.length === 0 ? [] : raw.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/**
 * A bounded read of an archived transcript.
 *
 * Archived transcripts always start at absolute offset 0, so a line's absolute
 * offset is the sum of the lengths of the lines before it.
 */
export function readArchive(
  dir: string,
  id: string,
  offset = 0,
  limit?: number,
  budget?: number
): BoundedReadResult | null {
  const lines = archiveLines(dir, id)
  if (lines === null) return null

  const start = Math.max(0, Math.floor(offset))
  const slice =
    limit === undefined ? lines.slice(start) : lines.slice(start, start + Math.max(0, limit))

  const lineStarts: number[] = []
  let running = 0
  for (const [index, line] of lines.entries()) {
    lineStarts[index] = running
    running += line.length + 1
  }

  const budgeted = applyLineBudget(slice, budget, (index) => {
    const lineStart = lineStarts[start + index]
    return lineStart ?? null
  })
  const delivered = start + budgeted.lines.length
  const moreLinesExist = delivered < lines.length
  const hasMore = budgeted.cutIndex !== null || moreLinesExist
  const since = lineStarts[start] ?? 0
  // Same reasoning as the live path: the numerator has to be stream characters,
  // matching the `bufferChars` denominator.
  const endOffset = budgeted.nextSince ?? lineStarts[delivered] ?? running

  return {
    lines: budgeted.lines,
    slices: budgeted.slices,
    totalLines: lines.length,
    offset: start,
    hasMore,
    shownChars: Math.max(0, endOffset - since),
    bufferChars: running,
    truncatedLines: budgeted.truncatedLines,
    nextSince: hasMore ? endOffset : null,
    since,
  }
}

/** Every line of an archived transcript matching `pattern`, bounded the same way. */
export function searchArchive(
  dir: string,
  id: string,
  pattern: RegExp,
  offset = 0,
  limit?: number,
  budget?: number
): BoundedSearchResult | null {
  const lines = archiveLines(dir, id)
  if (lines === null) return null

  const allMatches = lines
    .map((text, index) => ({ lineNumber: index + 1, text }))
    .filter((match) => pattern.test(match.text))

  const start = Math.max(0, Math.floor(offset))
  const limited =
    limit === undefined
      ? allMatches.slice(start)
      : allMatches.slice(start, start + Math.max(0, limit))

  const budgeted = applyLineBudget(
    limited.map((match) => match.text),
    budget,
    () => null
  )
  const matches = limited.slice(0, budgeted.lines.length).map((match, index) => ({
    lineNumber: match.lineNumber,
    text: budgeted.lines[index] ?? '',
  }))

  return {
    matches,
    totalMatches: allMatches.length,
    totalLines: lines.length,
    offset: start,
    hasMore: budgeted.truncatedLines === 1 || start + matches.length < allMatches.length,
    shownChars: budgeted.consumedChars,
    truncatedLines: budgeted.truncatedLines,
  }
}
