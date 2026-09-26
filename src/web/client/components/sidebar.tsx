import { useEffect, useState, type RefObject } from 'react'
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
}: {
  session: PTYSessionInfo
  activeSession: PTYSessionInfo | null
  onSessionClick: (session: PTYSessionInfo) => void
  onKillSession: (session: PTYSessionInfo) => void
  onRemoveSession: (session: PTYSessionInfo) => void
}) {
  const label = sessionLabel(session)
  const canKill = session.status === 'running'
  const isFinished = session.status === 'exited' || session.status === 'killed'

  return (
    <div className={`session-row ${isFinished ? 'finished' : ''}`}>
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
}: {
  group: PTYSessionGroup
  startOpen: boolean
  parentSessionTitles: Record<string, string>
  activeSession: PTYSessionInfo | null
  onSessionClick: (session: PTYSessionInfo) => void
  onKillSession: (session: PTYSessionInfo) => void
  onRemoveSession: (session: PTYSessionInfo) => void
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

  return (
    <details
      className="parent-session-group"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      data-parent-session-id={group.parentSessionId ?? 'ungrouped'}
      data-testid="parent-session-group"
    >
      <summary className="parent-session-summary" title={tooltip}>
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
  connected,
  themePreference,
  onThemePreferenceChange,
  onOpenSettings,
  onOpenDocs,
  docsButtonRef,
  settingsButtonRef,
}: SidebarProps) {
  const liveSessions = sessions.filter(isLive)
  const finishedSessions = sessions.filter((session) => !isLive(session))
  const liveGroups = groupSessionsByParent(liveSessions)
  const finishedGroups = groupSessionsByParent(finishedSessions)

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
      <div className="session-list">
        {sessions.length === 0 ? (
          <div className="session-empty">No active sessions</div>
        ) : (
          <>
            <SessionGroupSection
              title="Running"
              sectionClassName="session-section-running"
              groups={liveGroups}
              emptyText="No running sessions"
              groupsStartOpen
              parentSessionTitles={parentSessionTitles}
              activeSession={activeSession}
              onSessionClick={onSessionClick}
              onKillSession={onKillSession}
              onRemoveSession={onRemoveSession}
            />
            <SessionGroupSection
              title="Finished"
              sectionClassName="session-section-finished"
              groups={finishedGroups}
              emptyText="No finished sessions"
              groupsStartOpen={false}
              parentSessionTitles={parentSessionTitles}
              activeSession={activeSession}
              onSessionClick={onSessionClick}
              onKillSession={onKillSession}
              onRemoveSession={onRemoveSession}
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
