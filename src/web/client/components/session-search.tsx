import type { ChangeEvent, KeyboardEvent } from 'react'

interface SessionSearchProps {
  value: string
  onChange: (value: string) => void
  /** How many sessions survive the current query, for the live result count. */
  matchCount: number
  searching: boolean
}

/**
 * Sidebar filter box.
 *
 * Matches the parent OpenCode session title as well as the concrete PTY title,
 * description and command, so both "which conversation?" and "which process?"
 * are answerable from one field. Escape clears it.
 */
export function SessionSearch({ value, onChange, matchCount, searching }: SessionSearchProps) {
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape' && value !== '') {
      // Keep the dialog shortcuts from also seeing the keystroke.
      event.stopPropagation()
      onChange('')
    }
  }

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)

  return (
    <div className="session-search">
      <input
        type="search"
        className="session-search-input"
        placeholder="Filter sessions"
        aria-label="Filter sessions by group title, session title or command"
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
      />
      {value !== '' && (
        <button
          type="button"
          className="session-search-clear"
          onClick={() => onChange('')}
          aria-label="Clear session filter"
          title="Clear filter"
        >
          ×
        </button>
      )}
      {searching && (
        <span className="session-search-count" aria-live="polite">
          {matchCount}
        </span>
      )}
    </div>
  )
}
