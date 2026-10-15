/**
 * The sidebar's durable preferences, and every transition they can make.
 *
 * Durable, and not a per-process signal, because none of these is state the server owns: which
 * conversations a reader folded away, whether they want the archive open, whether the section is
 * collapsed, and what they last searched for are all choices, and they should survive a restart
 * the way the built-in sidebar items' do.
 *
 * The transitions are here rather than inline in the wiring for the reason `panel-state.ts` is
 * separate from the panel: a transition is worth stating once and reading on its own, and the
 * wiring is the least testable place to keep it. Like `panel-state`'s, each takes the state and
 * mutates it, which is exactly the shape the host's store hands to a setter.
 */

/** The store key these are persisted under. */
export const SIDEBAR_PREFS_KEY = 'opencode-pty.sidebar'

export interface SidebarPrefs {
  /** The whole section folded away. */
  collapsed: boolean
  /** Whether the footer's archive expansion is open. */
  showFinished: boolean
  /** The parent conversations the reader folded shut, by parent session id. */
  collapsedGroups: string[]
  /** The active filter, empty when there is none. */
  filter: string
}

export function initialSidebarPrefs(): SidebarPrefs {
  return { collapsed: true, showFinished: false, collapsedGroups: [], filter: '' }
}

/**
 * Fill in the preferences a store written by an OLDER build does not carry.
 *
 * The host's `store` persists an object and restores it as it was: `initial` is used only when
 * nothing was stored, and is never merged into what comes back. So every field added after a
 * reader's first run is `undefined` until something writes it - and reading one is not a missing
 * value but a crash: `filter` reached `normalizeQuery`, which calls `query.trim()`, and took the
 * whole `sidebar.content` slot down with "undefined is not an object". Repaired once per setup,
 * so no field added later has to remember this.
 *
 * `Partial` rather than `SidebarPrefs` on purpose: the type describes what this build writes,
 * not what a store from a previous one contains.
 */
export function fillMissingPrefs(prefs: Partial<SidebarPrefs>): void {
  const defaults = initialSidebarPrefs()
  if (typeof prefs.collapsed !== 'boolean') prefs.collapsed = defaults.collapsed
  if (typeof prefs.showFinished !== 'boolean') prefs.showFinished = defaults.showFinished
  if (!Array.isArray(prefs.collapsedGroups)) prefs.collapsedGroups = defaults.collapsedGroups
  if (typeof prefs.filter !== 'string') prefs.filter = defaults.filter
}

/**
 * Fold one parent conversation's rows shut, or open them again.
 *
 * Keyed by the parent session id, so a key left over from a conversation that is gone simply
 * never matches a group rather than reopening something.
 */
export function toggleGroup(prefs: SidebarPrefs, key: string): void {
  prefs.collapsedGroups = prefs.collapsedGroups.includes(key)
    ? prefs.collapsedGroups.filter((entry) => entry !== key)
    : [...prefs.collapsedGroups, key]
}

/**
 * Replace the filter, or clear it with an empty string.
 *
 * ONE function for both, because "cleared" is not a different state: the shared matcher treats
 * an empty query as no query, so a separate `clearFilter` would only be a second name for
 * `setFilter(prefs, '')`.
 */
export function setFilter(prefs: SidebarPrefs, query: string): void {
  prefs.filter = query
}
