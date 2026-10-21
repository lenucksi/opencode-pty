import { describe, expect, test } from 'bun:test'

import type { PanelSession } from '../src/tui/lib.ts'
import {
  emptyListLabel,
  endedBadly,
  FILTER_CHIP_MAX,
  FINISHED_LIMIT,
  failedFinished,
  failureCount,
  filterChipLabel,
  GROUP_AUTO_OPEN_LIMIT,
  groupsForDisplay,
  IDLE_STATUS,
  initialPanelState,
  isGroupOpen,
  isRunning,
  MAX_START_FAILURES,
  noteDialogClosed,
  noteDialogOpened,
  noteDialogOutput,
  noteDialogTick,
  noteListSuccess,
  noteNoServer,
  noteStartError,
  noteUnreachable,
  orderForDisplay,
  sessionCountForHeader,
  sessionCountLabel,
  statusWhenUnavailable,
  visibleSessions,
} from '../src/tui/panel-state.ts'
import { groupSessionsByParent } from '../src/web/shared/session-meta.ts'

/**
 * Every transition the panel can make, tested without a terminal.
 *
 * These are the decisions a human reads: what the header claims, when the panel
 * gives up on a server, and what a failure does to a list that was correct a
 * moment ago.
 */

const session = (over: Partial<PanelSession> = {}): PanelSession => ({ id: 'pty_1', ...over })

describe('initialPanelState', () => {
  test('starts with nothing and says so without claiming a server', () => {
    const state = initialPanelState()
    expect(state.sessions).toEqual([])
    expect(state.origin).toBeNull()
    expect(state.startFailures).toBe(0)
    expect(state.lastStartError).toBeNull()
    expect(state.dialog).toBeNull()
    // Not IDLE_STATUS: nothing has been tried yet, so "not running - click to
    // start" would be a statement about a server we have not looked for.
    expect(state.status).not.toBe(IDLE_STATUS)
  })
})

describe('sessionCountLabel', () => {
  test('says one session in words, not "1 sessions"', () => {
    expect(sessionCountLabel(1)).toBe('1 session')
    expect(sessionCountLabel(0)).toBe('0 sessions')
    expect(sessionCountLabel(2)).toBe('2 sessions')
  })
})

describe('statusWhenUnavailable', () => {
  test('invites the click while retries remain and nothing said why', () => {
    expect(statusWhenUnavailable(0, null)).toBe(IDLE_STATUS)
    expect(statusWhenUnavailable(2, null)).toBe(IDLE_STATUS)
  })

  // With the retries spent, the click no longer starts anything. "click to start"
  // would invite a gesture that does nothing, so the text names the one that does.
  test('names the gesture that still works once the retries are spent', () => {
    expect(statusWhenUnavailable(MAX_START_FAILURES, null)).toBe('unavailable — toggle to retry')
    expect(statusWhenUnavailable(MAX_START_FAILURES + 5, null)).toBe(
      'unavailable — toggle to retry'
    )
  })

  test('says it is trying until the retries are used up', () => {
    expect(statusWhenUnavailable(1, 'boom')).toBe('starting server…')
    expect(statusWhenUnavailable(MAX_START_FAILURES - 1, 'boom')).toBe('starting server…')
  })

  // The whole point of carrying the cause: the common one is that the PTY plugin is
  // not registered in this project's opencode.jsonc, and no retry fixes that.
  test('names the cause once retrying would be pointless', () => {
    expect(
      statusWhenUnavailable(MAX_START_FAILURES, 'command not found: pty-show-server-url')
    ).toBe('unavailable: command not found: pty-show-server-url')
  })

  test('keeps the cause to its first line and a readable width', () => {
    const noisy = `Error: something\n${'x'.repeat(200)}`
    const status = statusWhenUnavailable(MAX_START_FAILURES, noisy)
    expect(status).toBe(`unavailable: Error: something`)
    expect(status.length).toBeLessThanOrEqual('unavailable: '.length + 44)
  })

  // A remembered cause always arrives with at least one counted attempt: the start
  // records the cause, and the same refresh then increments the counter before it
  // asks for a status. So `cause !== null && failures === 0` cannot occur, and the
  // function is free to say "trying" there rather than pretending to know better.
  test('says it is trying once a cause exists, whatever the counter says', () => {
    expect(statusWhenUnavailable(0, 'boom')).toBe('starting server…')
    expect(statusWhenUnavailable(1, 'boom')).toBe('starting server…')
  })
})

describe('noteNoServer', () => {
  test('invites the click and counts nothing when nobody asked', () => {
    const state = initialPanelState()
    noteNoServer(state, false)
    expect(state.status).toBe(IDLE_STATUS)
    // Not a failure: a panel that has not been asked to start anything has not
    // failed at anything.
    expect(state.startFailures).toBe(0)
    expect(state.origin).toBeNull()
    expect(state.sessions).toEqual([])
  })

  test('counts an attempt that was asked for', () => {
    const state = initialPanelState()
    noteNoServer(state, true)
    expect(state.startFailures).toBe(1)
  })

  test('keeps the last list and says the server is gone', () => {
    // The rows are the last answer, not a claim about now: the status line carries
    // the "gone" part. Emptying the list here made the sidebar blank and refill on
    // every failed refresh, which a reader sees as the list reloading.
    const state = initialPanelState()
    noteListSuccess(state, 'http://127.0.0.1:1', [session({ id: 'a' })])
    expect(state.sessions).toHaveLength(1)
    noteNoServer(state, false)
    expect(state.sessions).toHaveLength(1)
    expect(state.origin).toBeNull()
    expect(state.status).not.toBe(sessionCountLabel(1))
  })
})

describe('orderForDisplay', () => {
  const at = (minutes: number): string =>
    new Date(Date.parse('2026-01-01T12:00:00Z') + minutes * 60_000).toISOString()

  // The list is every session the server knows, so on a machine with history it is
  // hundreds of finished records. A live one below them is a live one you cannot
  // watch, which is the whole reason this ordering exists.
  test('puts a running session above every finished one', () => {
    const list = [
      session({ id: 'old-finished', status: 'exited', createdAt: at(0) }),
      session({ id: 'live', status: 'running', createdAt: at(300) }),
      session({ id: 'new-finished', status: 'exited', createdAt: at(400) }),
    ]
    expect(orderForDisplay(list).map((s) => s.id)).toEqual(['live', 'new-finished', 'old-finished'])
  })

  test('keeps newest first inside each group', () => {
    const list = [
      session({ id: 'a', status: 'running', createdAt: at(10) }),
      session({ id: 'b', status: 'running', createdAt: at(20) }),
      session({ id: 'c', status: 'killed', createdAt: at(5) }),
      session({ id: 'd', status: 'exited', createdAt: at(30) }),
    ]
    expect(orderForDisplay(list).map((s) => s.id)).toEqual(['b', 'a', 'd', 'c'])
  })

  test('leaves the input alone, so the caller keeps what the server sent', () => {
    const list = [
      session({ id: 'a', status: 'exited', createdAt: at(0) }),
      session({ id: 'b', status: 'running', createdAt: at(1) }),
    ]
    orderForDisplay(list)
    expect(list.map((s) => s.id)).toEqual(['a', 'b'])
  })

  // A missing timestamp must not make the comparison throw and fall back to input
  // order, which would look like the ordering simply not applying.
  test('sorts a session without a usable timestamp last, without throwing', () => {
    const list = [
      session({ id: 'no-date', status: 'running' }),
      session({ id: 'dated', status: 'running', createdAt: at(5) }),
      session({ id: 'broken', status: 'running', createdAt: 'not a date' }),
    ]
    expect(orderForDisplay(list).map((s) => s.id)).toEqual(['dated', 'broken', 'no-date'])
  })

  // The two with no usable timestamp have the same activity, and the tie is broken by id
  // rather than by input position - so the order does not depend on which way the server
  // happened to send them. The private comparator this replaced left that to chance.
  test('breaks a tie deterministically, not by input order', () => {
    const forwards = [
      session({ id: 'a-broken', status: 'running', createdAt: 'nonsense' }),
      session({ id: 'b-broken', status: 'running', createdAt: 'nonsense' }),
    ]
    const backwards = [...forwards].reverse()
    expect(orderForDisplay(forwards).map((s) => s.id)).toEqual(['a-broken', 'b-broken'])
    expect(orderForDisplay(backwards).map((s) => s.id)).toEqual(['a-broken', 'b-broken'])
  })

  test('handles an empty list', () => {
    expect(orderForDisplay([])).toEqual([])
  })
})

describe('noteListSuccess', () => {
  test('records the server, the sessions and the count', () => {
    const state = initialPanelState()
    noteListSuccess(state, 'http://127.0.0.1:4200', [session({ id: 'a' }), session({ id: 'b' })])
    expect(state.origin).toBe('http://127.0.0.1:4200')
    expect(state.sessions.map((s) => s.id)).toHaveLength(2)
    expect(state.status).toBe('2 sessions')
  })

  // Every path that fills the list goes through here, so ordering it here is what
  // keeps the panel useful - a list built by any other route would arrive unsorted.
  test('stores the list already ordered, running first', () => {
    const state = initialPanelState()
    noteListSuccess(state, 'http://x', [
      session({ id: 'finished', status: 'exited', createdAt: '2026-01-01T10:00:00.000Z' }),
      session({ id: 'live', status: 'running', createdAt: '2026-01-01T09:00:00.000Z' }),
    ])
    expect(state.sessions.map((s) => s.id)).toEqual(['live', 'finished'])
  })

  // The count names everything, so the ordering hides nothing.
  test('counts every session, not only the ones it could show', () => {
    const state = initialPanelState()
    noteListSuccess(
      state,
      'http://x',
      Array.from({ length: 200 }, (_, n) => session({ id: `s${n}`, status: 'exited' }))
    )
    expect(state.status).toBe('200 sessions')
    expect(state.sessions).toHaveLength(200)
  })

  // The backoff has to reset here, or one success followed by one later failure
  // would skip straight to "unavailable" using a cause from the previous server.
  test('clears the backoff and the remembered cause', () => {
    const state = initialPanelState()
    state.startFailures = MAX_START_FAILURES
    state.lastStartError = 'old failure'
    noteListSuccess(state, 'http://127.0.0.1:1', [])
    expect(state.startFailures).toBe(0)
    expect(state.lastStartError).toBeNull()
    expect(state.status).toBe('0 sessions')
  })

  test('copies the list rather than holding the caller’s array', () => {
    const state = initialPanelState()
    const incoming = [session({ id: 'a' })]
    noteListSuccess(state, 'http://x', incoming)
    incoming.push(session({ id: 'b' }))
    // The store's value is what a render reads; a later push must not reach it.
    expect(state.sessions).toHaveLength(1)
  })
})

describe('noteUnreachable', () => {
  test('clears the origin so the next tick re-discovers it', () => {
    const state = initialPanelState()
    noteListSuccess(state, 'http://127.0.0.1:4200', [session()])
    noteUnreachable(state, new Error('boom'))
    // The server binds a fresh random port on every start, so keeping the old
    // address would keep asking a dead port forever.
    expect(state.origin).toBeNull()
    expect(state.status).toBe('server unreachable')
    expect(state.lastStartError).toContain('boom')
  })

  // Showing sessions next to an error invites the reading that the list is current.
  test('keeps the rows and says the list is stale', () => {
    // Same reason as noteNoServer: a failed refresh does not delete processes, and
    // clearing the list is what made the sidebar flicker on every timeout.
    const state = initialPanelState()
    noteListSuccess(state, 'http://x', [session({ id: 'a' })])
    noteUnreachable(state, 'nope')
    expect(state.sessions).toHaveLength(1)
    expect(state.status).toBe('server unreachable')
  })
})

describe('noteStartError', () => {
  test('remembers the cause without touching the status', () => {
    const state = initialPanelState()
    const before = state.status
    noteStartError(state, 'command not found')
    expect(state.lastStartError).toBe('command not found')
    // The status is the refresh's to write; this only records why it will.
    expect(state.status).toBe(before)
  })
})

describe('the dialog transitions', () => {
  test('opening shows a placeholder rather than an empty output', () => {
    const state = initialPanelState()
    noteDialogOpened(state, 'pty_7', 1000)
    expect(state.dialog).toEqual({ id: 'pty_7', output: 'loading…', now: 1000 })
  })

  test('a read lands in the open dialog', () => {
    const state = initialPanelState()
    noteDialogOpened(state, 'pty_7', 1000)
    noteDialogOutput(state, 'hello')
    expect(state.dialog?.output).toBe('hello')
  })

  // A stale buffer is what a second dialog shows for a poll interval, which reads
  // as the plugin reading the wrong session.
  test('closing clears it, so the next dialog cannot inherit it', () => {
    const state = initialPanelState()
    noteDialogOpened(state, 'pty_7', 1000)
    noteDialogOutput(state, 'first session output')
    noteDialogClosed(state)
    expect(state.dialog).toBeNull()
  })

  test('a tick advances the clock the run timer reads', () => {
    const state = initialPanelState()
    noteDialogOpened(state, 'pty_7', 1000)
    noteDialogTick(state, 2000)
    expect(state.dialog?.now).toBe(2000)
  })

  // The timers are cleared on close, but a stray tick must not resurrect the field
  // or crash on the null.
  test('a tick with no dialog open is a no-op, not a crash', () => {
    const state = initialPanelState()
    noteDialogTick(state, 2000)
    expect(state.dialog).toBeNull()
  })

  test('a late read with no dialog open is a no-op, not a crash', () => {
    const state = initialPanelState()
    noteDialogOutput(state, 'late')
    expect(state.dialog).toBeNull()
  })
})
describe('endedBadly', () => {
  test('a non-zero exit is news', () => {
    expect(endedBadly(session({ status: 'exited', exitCode: 1 }))).toBe(true)
    expect(endedBadly(session({ status: 'exited', exitCode: 2 }))).toBe(true)
  })

  // An exit 0 is a record, not an event. On a machine with history there are hundreds
  // of them, and treating them as interesting is what put 200 rows in a 40-column
  // sidebar.
  test('a clean exit is not', () => {
    expect(endedBadly(session({ status: 'exited', exitCode: 0 }))).toBe(false)
    expect(endedBadly(session({ status: 'killed' }))).toBe(false)
  })

  // A signal has no exit code, so a run killed by one reports the signal rather than
  // reading as "no reason given".
  test('a signal counts as a failure even without an exit code', () => {
    expect(endedBadly(session({ status: 'exited', exitSignal: 'SIGSEGV' }))).toBe(true)
    expect(endedBadly(session({ status: 'exited', exitSignal: '' }))).toBe(false)
  })
})

describe('visibleSessions', () => {
  // Written in a scrambled order and handed through `orderForDisplay`, because that is
  // the contract: these functions filter a list that `noteListSuccess` has already
  // ordered, they do not sort it. A second sort here would be a second place for the two
  // to disagree about which run is newer.
  const archive = (): PanelSession[] =>
    orderForDisplay([
      session({ id: 'ok-1', status: 'exited', exitCode: 0, createdAt: '2026-01-01T10:00:00Z' }),
      session({ id: 'bad-1', status: 'exited', exitCode: 1, createdAt: '2026-01-01T11:00:00Z' }),
      session({ id: 'live', status: 'running', lineCount: 12, createdAt: '2026-01-01T09:00:00Z' }),
      session({
        id: 'bad-2',
        status: 'killed',
        exitSignal: 'SIGTERM',
        createdAt: '2026-01-01T12:00:00Z',
      }),
      session({ id: 'ok-2', status: 'exited', exitCode: 0, createdAt: '2026-01-01T13:00:00Z' }),
    ])

  // The sidebar wins at glance, not at lookup: 200 finished records cannot be scanned
  // in 40 columns, and the three that carry news sit below 197 exit-0 rows.
  test('with the archive collapsed, only the running session is a row', () => {
    expect(visibleSessions(archive(), false).map((s) => s.id)).toEqual(['live'])
  })

  // Additive on purpose: expanding the archive must never hide the process that is
  // alive, so the running rows come first and are not replaced.
  test('expanding the archive appends the finished ones and keeps the live one', () => {
    // All finished rows, newest first - not only the failures. A clean exit is still
    // the run the reader just made.
    expect(visibleSessions(archive(), true).map((s) => s.id)).toEqual([
      'live',
      'ok-2',
      'bad-2',
      'bad-1',
      'ok-1',
    ])
  })

  // Newest first within the failed group. The order is inherited from
  // `orderForDisplay`, and this is what catches it if that stops sorting.
  test('the finished rows come newest first', () => {
    expect(
      visibleSessions(archive(), true)
        .slice(1)
        .map((s) => s.id)
    ).toEqual(['ok-2', 'bad-2', 'bad-1', 'ok-1'])
  })

  // `killing` is the transient state before the exit callback reports `killed`, and
  // there is nothing a reader could do about it.
  test('a session on its way out is not a row', () => {
    const list = [session({ id: 'going', status: 'killing', exitCode: 1 })]
    expect(visibleSessions(list, false)).toEqual([])
    expect(visibleSessions(list, true)).toEqual([])
  })

  test('an empty list stays empty', () => {
    expect(visibleSessions([], false)).toEqual([])
    expect(visibleSessions([], true)).toEqual([])
  })

  test('leaves the input alone', () => {
    const list = archive()
    visibleSessions(list, true)
    expect(list).toHaveLength(5)
  })

  // The filter preserves the order the list already has. This case fails if a second
  // sort is ever introduced here and disagrees with `orderForDisplay` about which run
  // is newer - which is the disagreement this contract exists to prevent.
  test('the failed rows keep the order the list already has', () => {
    const newestFirst = [
      session({ id: 'newer', status: 'exited', exitCode: 1, createdAt: '2026-01-01T12:00:00Z' }),
      session({ id: 'older', status: 'exited', exitCode: 2, createdAt: '2026-01-01T10:00:00Z' }),
    ]
    expect(failedFinished(newestFirst).map((s) => s.id)).toEqual(['newer', 'older'])
  })
})

describe('failureCount and failedFinished', () => {
  const manyFailures = (n: number): PanelSession[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `bad-${i}`,
      status: 'exited' as const,
      exitCode: 1,
      createdAt: new Date(Date.parse('2026-01-01T12:00:00Z') + i * 60_000).toISOString(),
    }))

  // The count is the archive's, not the visible rows'. If the count were capped like
  // the list, the footer would describe the screen instead of the state.
  test('the count is uncapped while the rows are capped', () => {
    const list = manyFailures(FINISHED_LIMIT + 7)
    expect(failureCount(list)).toBe(FINISHED_LIMIT + 7)
    expect(failedFinished(list)).toHaveLength(FINISHED_LIMIT)
  })

  test('keeps the newest failures when it has to cut', () => {
    const rows = failedFinished(orderForDisplay(manyFailures(FINISHED_LIMIT + 3)))
    expect(rows[0]?.id).toBe(`bad-${FINISHED_LIMIT + 2}`)
    expect(rows.at(-1)?.id).toBe('bad-3')
  })

  test('clean exits are neither counted nor shown', () => {
    const list = [
      session({ id: 'ok', status: 'exited', exitCode: 0 }),
      session({ id: 'bad', status: 'exited', exitCode: 3 }),
    ]
    expect(failureCount(list)).toBe(1)
    expect(failedFinished(list).map((s) => s.id)).toEqual(['bad'])
  })

  test('nothing finished means nothing failed', () => {
    expect(failureCount([session({ status: 'running' })])).toBe(0)
    expect(failedFinished([])).toEqual([])
  })
})

describe('isRunning', () => {
  test('only a running session is running', () => {
    expect(isRunning(session({ status: 'running' }))).toBe(true)
    for (const status of ['exited', 'killed', 'killing', undefined]) {
      expect(isRunning(session({ status }))).toBe(false)
    }
  })
})
describe('groupsForDisplay', () => {
  const ME = 'session-a'
  const OTHER = 'session-b'
  const at = (minutes: number): string =>
    new Date(Date.parse('2026-01-01T12:00:00Z') + minutes * 60_000).toISOString()

  const running = (id: string, parent: string | undefined, minutes: number) =>
    session({ id, parentSessionId: parent, status: 'running', createdAt: at(minutes) })
  const done = (id: string, parent: string | undefined, minutes: number) =>
    session({ id, parentSessionId: parent, status: 'exited', exitCode: 0, createdAt: at(minutes) })

  // A PTY session belongs to the OpenCode session that spawned it, so the panel groups
  // them the way the web sidebar does instead of listing one flat pile.
  test('keeps each parent conversation together', () => {
    const groups = groupsForDisplay([
      running('a1', ME, 5),
      running('a2', ME, 4),
      running('b1', OTHER, 6),
    ])
    const byKey = new Map(groups.map((group) => [group.key, group.sessions.map((s) => s.id)]))
    expect(byKey.get(ME)).toEqual(['a1', 'a2'])
    expect(byKey.get(OTHER)).toEqual(['b1'])
  })

  // A glance is for the thing that is alive. The shared order alone puts groups purely by
  // age, so a conversation started an hour ago with one live process would sit below one
  // started a minute ago with nothing running.
  test('puts a group with a running session first', () => {
    const groups = groupsForDisplay([done('old-1', ME, 1), running('fresh-1', OTHER, 60)])
    expect(groups.map((group) => group.key)).toEqual([OTHER, ME])
  })

  // The partition must not reshuffle anything: whatever the SHARED rule produced keeps its
  // order inside each half, and only the halves swap. Stated that way because an earlier
  // version of this case asserted the INPUT order, which the shared sort has already
  // replaced - so it would have described a bug as the expected result.
  test('keeps the shared order inside each half and only swaps the halves', () => {
    const list = [
      running('live-old', ME, 1),
      running('live-new', OTHER, 60),
      done('dead-a', 'session-c', 2),
      done('dead-b', 'session-d', 90),
    ]
    const shared = groupSessionsByParent(list).map((group) => group.key)
    const live = shared.filter((key) => key === ME || key === OTHER)
    const dead = shared.filter((key) => key !== ME && key !== OTHER)
    expect(groupsForDisplay(list).map((group) => group.key)).toEqual([...live, ...dead])
    // And the halves really are ordered by liveness, not by accident of the input.
    const actual = groupsForDisplay(list).map((group) => group.key)
    expect(actual.indexOf(OTHER)).toBeLessThan(actual.indexOf('session-d'))
    expect(actual.indexOf(ME)).toBeLessThan(actual.indexOf('session-c'))
  })

  // A session started by hand has no parent, and `groupSessionsByParent` gives it the
  // empty-key bucket. It must still be reachable - the panel would otherwise silently
  // hide every session the user started themselves.
  test('a session with no parent is grouped, not dropped', () => {
    const groups = groupsForDisplay([session({ id: 'hand-made', parentSessionId: undefined })])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.key).toBe('')
    expect(groups[0]?.sessions.map((s) => s.id)).toEqual(['hand-made'])
    expect(groups[0]?.parentSessionId).toBeUndefined()
  })

  // A blank parent id is the same case as a missing one: the shared rule trims it, and a
  // group keyed on an empty string that claims to have a parent would be a lie.
  test('a blank parent id counts as no parent', () => {
    const groups = groupsForDisplay([session({ id: 'blank', parentSessionId: '   ' })])
    expect(groups[0]?.key).toBe('')
    expect(groups[0]?.parentSessionId).toBeUndefined()
  })

  // The agent name rides along so the header can show it, and it is the SHARED field:
  // a second place that formats it would be a second answer.
  test('carries the agent that started the group', () => {
    const groups = groupsForDisplay([
      session({ id: 'x', parentSessionId: ME, parentAgent: 'build' }),
    ])
    expect(groups[0]?.parentAgent).toBe('build')
  })

  test('no sessions means no groups', () => {
    expect(groupsForDisplay([])).toEqual([])
  })

  test('leaves the input alone', () => {
    const list = [running('a', ME, 1), running('b', OTHER, 2)]
    groupsForDisplay(list)
    expect(list).toHaveLength(2)
  })
})

describe('isGroupOpen', () => {
  // The host's own rule, taken from its MCP sidebar: folding appears only once it saves
  // something, so a small group can never be hidden - not even by a fold key left over from
  // an earlier run.
  test('a group of one or two is always open, whatever the reader folded', () => {
    expect(isGroupOpen(1, 'ses_a', [])).toBe(true)
    expect(isGroupOpen(2, 'ses_a', ['ses_a'])).toBe(true)
    expect(isGroupOpen(GROUP_AUTO_OPEN_LIMIT, 'ses_a', ['ses_a'])).toBe(true)
  })

  test('a bigger group is open until its own key is folded', () => {
    expect(isGroupOpen(3, 'ses_a', [])).toBe(true)
    expect(isGroupOpen(3, 'ses_a', ['ses_a'])).toBe(false)
  })

  // Keyed by the parent session id: folding one conversation must not fold another, and a
  // key from a conversation that is gone must not match anything at all.
  test('folding one group leaves the others open', () => {
    expect(isGroupOpen(3, 'ses_b', ['ses_a'])).toBe(true)
    expect(isGroupOpen(3, 'ses_gone', ['ses_a'])).toBe(true)
  })
})

describe('groupsForDisplay with a query', () => {
  const ME = 'session-a'
  const OTHER = 'session-b'
  const at = (minutes: number): string =>
    new Date(Date.parse('2026-01-01T12:00:00Z') + minutes * 60_000).toISOString()
  const titled = (id: string, parent: string, title: string, over: Partial<PanelSession> = {}) =>
    session({ id, parentSessionId: parent, status: 'running', title, ...over })

  test('keeps every group and row when there is no query', () => {
    const groups = groupsForDisplay([titled('a1', ME, 'one'), titled('b1', OTHER, 'two')])
    expect(groups).toHaveLength(2)
    expect(groups.flatMap((group) => group.sessions)).toHaveLength(2)
  })

  test('keeps only the rows whose fields match', () => {
    const groups = groupsForDisplay(
      [titled('a1', ME, 'compile'), titled('a2', ME, 'link'), titled('b1', OTHER, 'deploy')],
      {},
      'link'
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]?.sessions.map((s) => s.id)).toEqual(['a2'])
  })

  // The shared rule, and the reason the heading is passed in: someone searching for a
  // conversation wants the processes it started, not only the row that matched.
  test('keeps a whole group whose heading matched', () => {
    const groups = groupsForDisplay(
      [titled('a1', ME, 'compile'), titled('a2', ME, 'link')],
      { [ME]: 'Deployment work' },
      'deployment'
    )
    expect(groups[0]?.sessions.map((s) => s.id)).toEqual(['a1', 'a2'])
  })

  test('a group left with nothing is gone, not drawn empty', () => {
    expect(groupsForDisplay([titled('a1', ME, 'one')], {}, 'nothing-matches-this')).toEqual([])
  })

  // The order keys on the SURVIVORS. `hasRunning` read from the unfiltered group would put
  // ME in the live half even though the query removed its only running row, and ME's survivor
  // is the newer one - so the shared order alone would then draw ME first.
  test('a group whose running row was filtered out no longer counts as running', () => {
    const groups = groupsForDisplay(
      [
        session({
          id: 'me-live',
          parentSessionId: ME,
          status: 'running',
          title: 'excluded',
          createdAt: at(1),
        }),
        session({
          id: 'me-dead',
          parentSessionId: ME,
          status: 'exited',
          exitCode: 1,
          title: 'survivor',
          createdAt: at(10),
        }),
        titled('other-live', OTHER, 'survivor', { createdAt: at(2) }),
      ],
      {},
      'survivor'
    )
    expect(groups.map((group) => group.key)).toEqual([OTHER, ME])
    expect(groups[1]?.hasRunning).toBe(false)
  })
})

describe('sessionCountForHeader', () => {
  test('is the plain total with no filter', () => {
    expect(sessionCountForHeader(200, 200, '')).toBe('200 sessions')
    expect(sessionCountForHeader(1, 1, '   ')).toBe('1 session')
  })

  // Both numbers, because either alone is a half-truth: the total would hide that the filter
  // narrowed anything, and the shown count alone would read as a smaller archive.
  test('names both numbers while a filter is active', () => {
    expect(sessionCountForHeader(200, 2, 'build')).toBe('2 of 200')
    expect(sessionCountForHeader(200, 0, 'build')).toBe('0 of 200')
  })
})

describe('emptyListLabel', () => {
  test('says nothing is running when no filter is set', () => {
    expect(emptyListLabel('')).toBe('   nothing running')
    expect(emptyListLabel('   ')).toBe('   nothing running')
  })

  // A bare "nothing running" under a filter claims no process is alive, which is a different
  // statement from the query having excluded them all. Echoes what was typed, not the needle.
  test('names the query while a filter is active', () => {
    expect(emptyListLabel('Build')).toBe('   nothing matches “Build”')
    expect(emptyListLabel('  build  ')).toBe('   nothing matches “build”')
  })
})

describe('filterChipLabel', () => {
  test('is empty without a filter, so the header offers no click that clears nothing', () => {
    expect(filterChipLabel('')).toBe('')
    expect(filterChipLabel('  ')).toBe('')
  })

  test('shows the query with the click that clears it', () => {
    expect(filterChipLabel(' build ')).toBe('build ✕')
  })

  // Clipped, or a long query would push the count off a ~40-column header.
  test('clips a long query', () => {
    expect(filterChipLabel('x'.repeat(40))).toBe(`${'x'.repeat(FILTER_CHIP_MAX - 1)}… ✕`)
  })
})
