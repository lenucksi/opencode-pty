import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { PTYSessionInfo } from 'opencode-pty/web/shared/types'

import { WEB_API_PARENT_SESSION_ID } from '../../../plugin/constants.ts'
import {
  groupSessionsByParent,
  parentSessionGroupTitle,
  type PTYSessionGroup,
  sessionCommandLine,
  sessionSidebarMeta,
  sessionTooltip,
} from '../../shared/session-meta.ts'
import { countSessions, filterGroups, normalizeQuery } from '../../shared/session-search.ts'
import { SessionSearch } from './session-search.tsx'
import type { ThemePreference } from '../lib/theme.ts'
import { ThemeSwitch } from './theme-switch.tsx'

interface SidebarProps {
  sessions: PTYSessionInfo[]
  parentSessionTitles: Record<string, string>
  activeSession: PTYSessionInfo | null
  onSessionClick: (session: PTYSessionInfo) => void
  onKillSession: (session: PTYSessionInfo) => void
  onRemoveSession: (session: PTYSessionInfo) => void
  onClearFinished: () => void
  /**
   * Remove exactly these ids. `hiddenByFilter` is how many of them the current
   * search hides, and it is passed rather than recomputed because the confirmation
   * has to name it before anything is gone.
   */
  onRemoveSelection: (ids: string[], hiddenByFilter: number) => void
  connected: boolean
  themePreference: ThemePreference
  onThemePreferenceChange: (preference: ThemePreference) => void
  onOpenSettings: () => void
  onOpenDocs: () => void
  docsButtonRef?: RefObject<HTMLButtonElement | null>
  settingsButtonRef: RefObject<HTMLButtonElement | null>
}

interface SessionGroupSectionProps {
  title: string
  sectionClassName: string
  groups: PTYSessionGroup[]
  emptyText: string
  groupsStartOpen: boolean
  parentSessionTitles: Record<string, string>
  activeSession: PTYSessionInfo | null
  onSessionClick: (session: PTYSessionInfo) => void
  onKillSession: (session: PTYSessionInfo) => void
  onRemoveSession: (session: PTYSessionInfo) => void
  selectionMode: boolean
  selected: ReadonlySet<string>
  onToggleSelected: (session: PTYSessionInfo) => void
  onToggleGroup: (sessions: PTYSessionInfo[]) => void
  action?: React.ReactNode
}

/** A session is "live" until its process has actually exited. */
function isLive(session: PTYSessionInfo): boolean {
  return session.status === 'running' || session.status === 'killing'
}

function sessionLabel(session: PTYSessionInfo): string {
  return session.description ?? session.title
}

function SessionItem({
  session,
  activeSession,
  onSessionClick,
  onKillSession,
  onRemoveSession,
  selectionMode,
  selected,
  onToggleSelected,
}: {
  session: PTYSessionInfo
  activeSession: PTYSessionInfo | null
  onSessionClick: (session: PTYSessionInfo) => void
  onKillSession: (session: PTYSessionInfo) => void
  onRemoveSession: (session: PTYSessionInfo) => void
  selectionMode: boolean
  selected: boolean
  onToggleSelected: (session: PTYSessionInfo) => void
}) {
  const label = sessionLabel(session)
  const canKill = session.status === 'running'
  const isFinished = session.status === 'exited' || session.status === 'killed'

  return (
    <div className={`session-row ${isFinished ? 'finished' : ''}`}>
      {/*
       * A real checkbox, not a div with a click handler. In selection mode the
       * whole row is a label target, so the control has to expose its own state
       * to assistive technology - `aria-pressed` on a button would announce a
       * toggle without saying whether the thing is selected right now.
       */}
      {selectionMode ? (
        <input
          type="checkbox"
          className="session-select"
          checked={selected}
          onChange={() => onToggleSelected(session)}
          aria-label={`Select session ${label}`}
          data-testid={`session-select-${session.id}`}
        />
      ) : null}
      <button
        type="button"
        className={`session-item ${activeSession?.id === session.id ? 'active' : ''}`}
        onClick={() => onSessionClick(session)}
      >
        <div className="session-title">{label}</div>
        <div className="session-info">
          <span className="session-command" title={sessionTooltip(session)}>
            {sessionCommandLine(session)}
          </span>
          <span className={`status-badge status-${session.status}`}>{session.status}</span>
        </div>
        <div className="session-meta" title={sessionTooltip(session)}>
          {/* One bounded line; the tooltip carries the full command and workdir. */}
          <span className="session-detail">{sessionSidebarMeta(session)}</span>
          {session.lost ? <span className="session-lost">lost in a restart</span> : null}
        </div>
      </button>
      {/* The per-row actions are a liability in selection mode: a Remove
            button next to a checkbox invites removing the one you did not mean
            to. They stay reachable outside it. */}
      {selectionMode ? null : (
        <div className="session-actions">
          {canKill ? (
            <button
              type="button"
              className="session-action session-action-kill"
              title="Kill session"
              aria-label={`Kill session ${label}`}
              onClick={() => onKillSession(session)}
            >
              Kill
            </button>
          ) : null}
          {isFinished ? (
            <button
              type="button"
              className="session-action session-action-remove"
              title="Remove finished session"
              aria-label={`Remove finished session ${label}`}
              onClick={() => onRemoveSession(session)}
            >
              Remove
            </button>
          ) : null}
        </div>
      )}
    </div>
  )
}

function SessionGroup({
  group,
  startOpen,
  parentSessionTitles,
  activeSession,
  onSessionClick,
  onKillSession,
  onRemoveSession,
  selectionMode,
  selected,
  onToggleSelected,
  onToggleGroup,
}: {
  group: PTYSessionGroup
  startOpen: boolean
  parentSessionTitles: Record<string, string>
  activeSession: PTYSessionInfo | null
  onSessionClick: (session: PTYSessionInfo) => void
  onKillSession: (session: PTYSessionInfo) => void
  onRemoveSession: (session: PTYSessionInfo) => void
  selectionMode: boolean
  /** Ids selected anywhere in this group's sessions, whether or not they are shown. */
  selected: ReadonlySet<string>
  onToggleSelected: (session: PTYSessionInfo) => void
  onToggleGroup: (sessions: PTYSessionInfo[]) => void
}) {
  const title = parentSessionGroupTitle(group, parentSessionTitles)
  const containsActiveSession = group.sessions.some((session) => session.id === activeSession?.id)
  const shouldBeOpen = startOpen || containsActiveSession
  const [open, setOpen] = useState(shouldBeOpen)
  useEffect(() => {
    if (shouldBeOpen) setOpen(true)
  }, [shouldBeOpen])
  const showParentID =
    group.parentSessionId !== undefined && group.parentSessionId !== WEB_API_PARENT_SESSION_ID
  const tooltip = [
    title,
    showParentID ? `parent session: ${group.parentSessionId}` : '',
    group.parentAgent ? `agent: ${group.parentAgent}` : '',
  ]
    .filter(Boolean)
    .join('\n')
  const selectedHere = group.sessions.filter((session) => selected.has(session.id)).length
  const allSelected = group.sessions.length > 0 && selectedHere === group.sessions.length
  const someSelected = selectedHere > 0 && !allSelected
  const groupSelectRef = useRef<HTMLInputElement>(null)

  // `indeterminate` has no HTML attribute - it only exists as a property, so it
  // has to be set after render or a partly selected group reads as unselected.
  useEffect(() => {
    const input = groupSelectRef.current
    if (input) input.indeterminate = someSelected
  }, [someSelected])

  return (
    <details
      className="parent-session-group"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      data-parent-session-id={group.parentSessionId ?? 'ungrouped'}
      data-testid="parent-session-group"
    >
      <summary className="parent-session-summary" title={tooltip}>
        {/*
         * Inside the summary on purpose: a group's checkbox is a way to select
         * the group, and it has to sit where the group is named. The click
         * handler stops the event so choosing a group does not also fold it.
         */}
        {selectionMode ? (
          <input
            type="checkbox"
            ref={groupSelectRef}
            className="session-group-select"
            checked={allSelected}
            onClick={(event) => event.stopPropagation()}
            onChange={() => onToggleGroup(group.sessions)}
            aria-label={`Select all sessions in ${title}`}
            data-testid={`group-select-${group.key}`}
          />
        ) : null}
        <span className="parent-session-title">{title}</span>
        <span className="parent-session-meta">
          {group.parentAgent ? <span>{group.parentAgent}</span> : null}
          {showParentID ? <span className="parent-session-id">{group.parentSessionId}</span> : null}
          <span>
            {group.sessions.length} session{group.sessions.length === 1 ? '' : 's'}
          </span>
        </span>
      </summary>
      <div className="parent-session-items">
        {group.sessions.map((session) => (
          <SessionItem
            key={session.id}
            session={session}
            activeSession={activeSession}
            onSessionClick={onSessionClick}
            onKillSession={onKillSession}
            onRemoveSession={onRemoveSession}
            selectionMode={selectionMode}
            selected={selected.has(session.id)}
            onToggleSelected={onToggleSelected}
          />
        ))}
      </div>
    </details>
  )
}

function SessionGroupSection({
  title,
  sectionClassName,
  groups,
  emptyText,
  groupsStartOpen,
  parentSessionTitles,
  activeSession,
  onSessionClick,
  onKillSession,
  onRemoveSession,
  selectionMode,
  selected,
  onToggleSelected,
  onToggleGroup,
  action,
}: SessionGroupSectionProps) {
  const sessionCount = groups.reduce((count, group) => count + group.sessions.length, 0)

  return (
    <section className={`session-section ${sectionClassName}`}>
      <div className="session-section-header">
        <span className="session-section-title">{title}</span>
        <span className="session-section-count">{sessionCount}</span>
        {action}
      </div>
      {groups.length === 0 ? (
        <div className="session-section-empty">{emptyText}</div>
      ) : (
        groups.map((group) => (
          <SessionGroup
            key={group.key}
            group={group}
            startOpen={groupsStartOpen}
            parentSessionTitles={parentSessionTitles}
            activeSession={activeSession}
            onSessionClick={onSessionClick}
            onKillSession={onKillSession}
            onRemoveSession={onRemoveSession}
            selectionMode={selectionMode}
            selected={selected}
            onToggleSelected={onToggleSelected}
            onToggleGroup={onToggleGroup}
          />
        ))
      )}
    </section>
  )
}

export function Sidebar({
  sessions,
  parentSessionTitles,
  activeSession,
  onSessionClick,
  onKillSession,
  onRemoveSession,
  onClearFinished,
  onRemoveSelection,
  connected,
  themePreference,
  onThemePreferenceChange,
  onOpenSettings,
  onOpenDocs,
  docsButtonRef,
  settingsButtonRef,
}: SidebarProps) {
  const [query, setQuery] = useState('')
  const [selectionMode, setSelectionMode] = useState(false)
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set<string>())
  const liveSessions = sessions.filter(isLive)
  const finishedSessions = sessions.filter((session) => !isLive(session))
  const searching = normalizeQuery(query) !== null
  const applyFilter = (list: PTYSessionInfo[]) =>
    filterGroups(
      groupSessionsByParent(list),
      (group) => parentSessionGroupTitle(group, parentSessionTitles),
      query
    ).map(({ group, sessions: kept }) => ({ ...group, sessions: kept }))
  const liveGroups = applyFilter(liveSessions)
  const finishedGroups = applyFilter(finishedSessions)
  // Derived from the surviving groups, not from a per-session match: a query can
  // match only the group title and still keep every child visible.
  const matchCount = countSessions(liveGroups) + countSessions(finishedGroups)
  const nothingVisible = liveGroups.length === 0 && finishedGroups.length === 0

  // Selection is per id and survives the filter, on purpose: the filter decides
  // what a reader sees, the selection decides what an action affects, and a
  // search that silently shrank a selection would remove rows nobody could see
  // had been picked. The count of hidden picks is reported instead of hidden.
  const visibleIds = [...liveGroups, ...finishedGroups].flatMap((group) =>
    group.sessions.map((session) => session.id)
  )
  const hiddenSelected = [...selected].filter((id) => !visibleIds.includes(id)).length

  const toggleSelected = useCallback((session: PTYSessionInfo) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(session.id)) next.delete(session.id)
      else next.add(session.id)
      return next
    })
  }, [])

  const toggleGroup = useCallback((groupSessions: PTYSessionInfo[]) => {
    setSelected((current) => {
      const allPicked = groupSessions.every((session) => current.has(session.id))
      const next = new Set(current)
      for (const session of groupSessions) {
        if (allPicked) next.delete(session.id)
        else next.add(session.id)
      }
      return next
    })
  }, [])

  const selectAllVisible = useCallback(() => {
    setSelected((current) => new Set([...current, ...visibleIds]))
  }, [visibleIds])

  const exitSelection = useCallback(() => {
    setSelectionMode(false)
    setSelected(new Set())
  }, [])

  // ESC leaves selection mode, the way it leaves the dialogs. Bound while the
  // mode is on so it cannot swallow ESC anywhere else in the app.
  useEffect(() => {
    if (!selectionMode) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') exitSelection()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [selectionMode, exitSelection])

  const handleRemoveSelection = useCallback(() => {
    if (selected.size === 0) return
    onRemoveSelection([...selected], hiddenSelected)
  }, [selected, hiddenSelected, onRemoveSelection])

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <h1>PTY Sessions</h1>
        <div className="sidebar-header-controls">
          <ThemeSwitch preference={themePreference} onChange={onThemePreferenceChange} />
          <button
            type="button"
            ref={docsButtonRef}
            className="settings-btn"
            onClick={onOpenDocs}
            aria-haspopup="dialog"
            title="Documentation (Ctrl+/)"
          >
            Docs
          </button>
          <button
            type="button"
            ref={settingsButtonRef}
            className="settings-btn"
            onClick={onOpenSettings}
            aria-haspopup="dialog"
            title="Settings (Ctrl+,)"
          >
            Settings
          </button>
        </div>
      </div>
      <div className={`connection-status ${connected ? 'connected' : 'disconnected'}`}>
        {connected ? '● Connected' : '○ Disconnected'}
      </div>
      <SessionSearch
        value={query}
        onChange={setQuery}
        matchCount={matchCount}
        searching={searching}
      />
      {selectionMode ? (
        <div className="selection-toolbar" data-testid="selection-toolbar">
          {/* aria-live because the count changes on every click and nothing
              else on screen moves when it does. */}
          <span className="selection-count" aria-live="polite" data-testid="selection-count">
            {selected.size} selected
          </span>
          {hiddenSelected > 0 ? (
            <span className="selection-hidden" data-testid="selection-hidden">
              {hiddenSelected} hidden by search
              <button
                type="button"
                className="selection-show-hidden"
                onClick={() => setQuery('')}
                data-testid="selection-show-hidden"
              >
                Show
              </button>
            </span>
          ) : null}
          <button
            type="button"
            className="selection-select-visible"
            onClick={selectAllVisible}
            data-testid="selection-select-visible"
          >
            Select all visible
          </button>
          <button
            type="button"
            className="selection-remove"
            onClick={handleRemoveSelection}
            disabled={selected.size === 0}
            data-testid="selection-remove"
          >
            Remove selected
          </button>
          <button
            type="button"
            className="selection-cancel"
            onClick={exitSelection}
            data-testid="selection-cancel"
          >
            Cancel
          </button>
        </div>
      ) : sessions.length > 0 ? (
        <div className="selection-toolbar selection-toolbar-idle">
          <button
            type="button"
            className="selection-enter"
            onClick={() => setSelectionMode(true)}
            data-testid="selection-enter"
          >
            Select sessions
          </button>
        </div>
      ) : null}
      <div className="session-list">
        {searching && nothingVisible ? (
          <div className="session-empty">No session matches “{query.trim()}”</div>
        ) : sessions.length === 0 ? (
          <div className="session-empty">No active sessions</div>
        ) : (
          <>
            <SessionGroupSection
              title="Running"
              sectionClassName="session-section-running"
              groups={liveGroups}
              emptyText={searching ? 'No running session matches' : 'No running sessions'}
              groupsStartOpen
              parentSessionTitles={parentSessionTitles}
              activeSession={activeSession}
              onSessionClick={onSessionClick}
              onKillSession={onKillSession}
              onRemoveSession={onRemoveSession}
              selectionMode={selectionMode}
              selected={selected}
              onToggleSelected={toggleSelected}
              onToggleGroup={toggleGroup}
            />
            <SessionGroupSection
              title="Finished"
              sectionClassName="session-section-finished"
              groups={finishedGroups}
              emptyText={searching ? 'No finished session matches' : 'No finished sessions'}
              groupsStartOpen={false}
              parentSessionTitles={parentSessionTitles}
              activeSession={activeSession}
              onSessionClick={onSessionClick}
              onKillSession={onKillSession}
              onRemoveSession={onRemoveSession}
              selectionMode={selectionMode}
              selected={selected}
              onToggleSelected={toggleSelected}
              onToggleGroup={toggleGroup}
              action={
                finishedSessions.length > 0 ? (
                  <button type="button" className="clear-finished-btn" onClick={onClearFinished}>
                    Clear finished
                  </button>
                ) : null
              }
            />
          </>
        )}
      </div>
    </div>
  )
}
