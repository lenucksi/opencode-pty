import type { PTYSessionInfo } from './types.ts'

/**
 * Sidebar search.
 *
 * The query is matched case-insensitively as a substring against the group
 * title (the parent OpenCode session) and against every field of a concrete PTY
 * session that is already visible in its row: title, description, command line
 * and the agent that ran it.
 *
 * A group survives when its own title matches - someone searching for a parent
 * conversation wants to see that whole group - or when at least one child
 * matches. A group with neither match disappears entirely, and so do its
 * children.
 */

export interface SessionSearchHit {
  session: PTYSessionInfo
  /** True when the group title itself matched, not just this child. */
  groupMatched: boolean
}

export interface GroupFilterInput<TGroup extends { sessions: readonly PTYSessionInfo[] }> {
  group: TGroup
  title: string
}

export interface GroupFilterResult<TGroup extends { sessions: readonly PTYSessionInfo[] }> {
  group: TGroup
  /** The group's sessions that survived; equals `group.sessions` on a title match. */
  sessions: PTYSessionInfo[]
  groupMatched: boolean
}

/** Every field of a session a user can reasonably search by. */
function sessionHaystack(session: PTYSessionInfo): string {
  return [
    session.title,
    session.description,
    [session.command, ...session.args].join(' '),
    session.parentAgent,
    session.id,
  ]
    .filter((part): part is string => typeof part === 'string')
    .join(' ')
    .toLowerCase()
}

/** Normalised query, or `null` when the search is inactive. */
export function normalizeQuery(query: string): string | null {
  const trimmed = query.trim().toLowerCase()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Case-insensitive substring test.
 *
 * The needle is normalised here rather than relying on the caller, so the
 * primitive cannot be used incorrectly on its own.
 */
export function sessionMatches(session: PTYSessionInfo, query: string): boolean {
  const needle = normalizeQuery(query)
  if (needle === null) return true
  return sessionHaystack(session).includes(needle)
}

/**
 * Filter groups and their children by the query.
 *
 * Pure so the behaviour can be unit tested without a DOM: counters, the
 * group-title rule and the child rule all live here.
 */
export function filterGroups<TGroup extends { sessions: readonly PTYSessionInfo[] }>(
  groups: readonly TGroup[],
  titleOf: (group: TGroup) => string,
  query: string
): GroupFilterResult<TGroup>[] {
  const needle = normalizeQuery(query)
  if (needle === null) {
    return groups.map((group) => ({ group, sessions: [...group.sessions], groupMatched: false }))
  }

  const results: GroupFilterResult<TGroup>[] = []
  for (const group of groups) {
    const groupMatched = titleOf(group).toLowerCase().includes(needle)
    const sessions = groupMatched
      ? [...group.sessions]
      : group.sessions.filter((session) => sessionMatches(session, needle))
    if (sessions.length === 0) continue
    results.push({ group, sessions, groupMatched })
  }
  return results
}

/** Total session count across a set of groups, for the section counters. */
export function countSessions<TGroup extends { sessions: readonly PTYSessionInfo[] }>(
  groups: readonly GroupFilterResult<TGroup>[] | readonly TGroup[]
): number {
  return groups.reduce((total, entry) => total + entry.sessions.length, 0)
}
