import { describe, expect, test } from 'bun:test'
import { testRender } from '@opentui/solid'

import type { PanelSession } from '../src/tui/lib.ts'
import {
  initialSessionPanelState,
  LOADING_SCREEN,
  NO_SELECTION_SCREEN,
  noteSessionPanelInput,
  noteSessionPanelList,
  noteSessionScreen,
  noteSessionSelected,
  panelScreenRows,
  selectedLive,
  selectedSession,
  sessionsForSession,
  sessionPanelView,
  type SessionPanelView,
} from '../src/tui/session-panel.ts'

/**
 * The session panel's decisions, without a terminal.
 *
 * These are the ones a reader feels: which processes this conversation started, which
 * one is on screen, and what the panel says when there is nothing.
 */

const ME = 'session-1'
const OTHER = 'session-2'

const session = (over: Partial<PanelSession> = {}): PanelSession => ({
  id: 'pty_1',
  parentSessionId: ME,
  ...over,
})

const at = (minutes: number): string =>
  new Date(Date.parse('2026-01-01T12:00:00Z') + minutes * 60_000).toISOString()

const tones = {
  base: '#d8dee9',
  muted: '#4c566a',
  success: '#a3be8c',
  error: '#bf616a',
  border: '#3b4252',
  raised: '#242832',
}

describe('sessionsForSession', () => {
  // The whole reason this surface exists: a PTY session belongs to the conversation that
  // spawned it, so the panel shows that conversation's processes and nobody else's.
  test('keeps only the sessions this OpenCode session started', () => {
    const list = [
      session({ id: 'mine-1' }),
      session({ id: 'theirs', parentSessionId: OTHER }),
      session({ id: 'hand-made', parentSessionId: undefined }),
    ]
    expect(sessionsForSession(list, ME).map((s) => s.id)).toEqual(['mine-1'])
  })

  // A session started by hand has no parent, so it belongs to no conversation's panel.
  // Showing it in every panel would be wrong; showing it in none loses it - which is what
  // the web UI is for.
  test('a session with no parent belongs to no panel', () => {
    expect(sessionsForSession([session({ id: 'orphan', parentSessionId: undefined })], ME)).toEqual(
      []
    )
  })

  test('orders the result like the sidebar does: running first', () => {
    const list = [
      session({ id: 'done', status: 'exited', exitCode: 0, createdAt: at(0) }),
      session({ id: 'live', status: 'running', createdAt: at(1) }),
    ]
    expect(sessionsForSession(list, ME).map((s) => s.id)).toEqual(['live', 'done'])
  })

  test('an empty list stays empty', () => {
    expect(sessionsForSession([], ME)).toEqual([])
  })
})

describe('noteSessionPanelList', () => {
  test('records the list for this session', () => {
    const state = initialSessionPanelState()
    noteSessionPanelList(
      state,
      [session({ id: 'a' }), session({ id: 'b', parentSessionId: OTHER })],
      ME
    )
    expect(state.sessions.map((s) => s.id)).toEqual(['a'])
  })

  // The reader picked a process; a poll arriving must not move the selection out from
  // under them.
  test('a selection that still exists survives the refresh', () => {
    const state = initialSessionPanelState()
    noteSessionPanelList(state, [session({ id: 'a' }), session({ id: 'b' })], ME)
    noteSessionSelected(state, 'b')
    noteSessionPanelList(state, [session({ id: 'a' }), session({ id: 'b' })], ME)
    expect(state.selected).toBe('b')
  })

  // The chosen process was removed. What gets selected is the FIRST ROW of the ordered
  // group, and the ordering puts running sessions first - so this is the running one,
  // and showing nothing would hide the only process alive.
  //
  // Worth stating that the reason is the ordering and not a search of its own: the input
  // below lists the finished session FIRST, so a test that only checked the outcome would
  // pass even if the ordering were dropped. `sessionsForSession`'s own ordering case is
  // what covers that half.
  test('a selection that vanished falls back to the first row of the ordered group', () => {
    const state = initialSessionPanelState()
    state.selected = 'gone'
    noteSessionPanelList(
      state,
      [
        session({ id: 'done', status: 'exited', exitCode: 0, createdAt: at(0) }),
        session({ id: 'live', status: 'running', createdAt: at(1) }),
      ],
      ME
    )
    expect(state.selected).toBe('live')
  })

  test('with nothing running the first row is selected rather than nothing', () => {
    const state = initialSessionPanelState()
    state.selected = 'gone'
    noteSessionPanelList(state, [session({ id: 'first', status: 'exited', exitCode: 1 })], ME)
    expect(state.selected).toBe('first')
  })

  test('an empty group selects nothing and says so', () => {
    const state = initialSessionPanelState()
    noteSessionPanelList(state, [], ME)
    expect(state.selected).toBeNull()
    expect(state.screen).toBe(NO_SELECTION_SCREEN)
  })
})

describe('noteSessionPanelInput', () => {
  test('records which session the panel belongs to', () => {
    const state = initialSessionPanelState()
    expect(state.sessionID).toBeNull()
    noteSessionPanelInput(state, ME)
    expect(state.sessionID).toBe(ME)
  })
})

describe('the selected row', () => {
  test('is the one the state names', () => {
    const state = initialSessionPanelState()
    noteSessionPanelList(state, [session({ id: 'a' }), session({ id: 'b' })], ME)
    noteSessionSelected(state, 'b')
    expect(selectedSession(state)?.id).toBe('b')
  })

  test('is null when nothing is selected', () => {
    expect(selectedSession(initialSessionPanelState())).toBeNull()
  })

  // The panel keeps a snapshot and the sidebar keeps a fresh list. A process that exits
  // while its screen is on screen would keep a running timer if the panel read its own
  // stale copy - so the fresh list wins.
  test('reads its state from the fresh list, so a finished process stops the timer', () => {
    const state = initialSessionPanelState()
    noteSessionPanelList(state, [session({ id: 'a', status: 'running' })], ME)
    expect(selectedLive(state, [session({ id: 'a', status: 'running' })])?.status).toBe('running')
    expect(selectedLive(state, [session({ id: 'a', status: 'exited', exitCode: 0 })])?.status).toBe(
      'exited'
    )
  })

  test('falls back to its own copy when the fresh list has lost the row', () => {
    const state = initialSessionPanelState()
    noteSessionPanelList(state, [session({ id: 'a', status: 'running' })], ME)
    expect(selectedLive(state, [])?.id).toBe('a')
  })
})

describe('noteSessionSelected', () => {
  test('switching marks the screen as loading, so a stale screen is never shown', () => {
    const state = initialSessionPanelState()
    noteSessionPanelList(state, [session({ id: 'a' }), session({ id: 'b' })], ME)
    noteSessionScreen(state, 'the old screen', Date.now())
    noteSessionSelected(state, 'b')
    expect(state.screen).toBe(LOADING_SCREEN)
  })

  test('picking the row already on screen changes nothing', () => {
    const state = initialSessionPanelState()
    noteSessionPanelList(state, [session({ id: 'a' })], ME)
    noteSessionScreen(state, 'kept', Date.now())
    noteSessionSelected(state, 'a')
    expect(state.screen).toBe('kept')
  })
})

describe('noteSessionScreen', () => {
  test('records the screen and the clock the run timer reads', () => {
    const state = initialSessionPanelState()
    noteSessionPanelList(state, [session({ id: 'a' })], ME)
    noteSessionScreen(state, 'line one', 1234)
    expect(state.screen).toBe('line one')
    expect(state.now).toBe(1234)
  })

  // A read that lands after the reader moved on must not overwrite what they are now
  // looking at.
  test('is ignored when nothing is selected', () => {
    const state = initialSessionPanelState()
    noteSessionScreen(state, 'orphan read', 1)
    expect(state.screen).not.toBe('orphan read')
  })
})

describe('panelScreenRows', () => {
  test('leaves room for the list and the frame', () => {
    expect(panelScreenRows(40, 4)).toBe(12)
  })

  // Never zero: a screen box with no height shows nothing at all, which looks like a
  // broken panel rather than a small terminal.
  test('never drops below three rows, however small the terminal', () => {
    expect(panelScreenRows(10, 40)).toBe(3)
    expect(panelScreenRows(4, 40)).toBe(3)
    expect(panelScreenRows(0, 0)).toBe(3)
  })
})

describe('sessionPanelView', () => {
  const view = (over: Partial<Parameters<typeof sessionPanelView>[0]> = {}): SessionPanelView => ({
    tones,
    state: initialSessionPanelState(),
    live: [],
    focused: false,
    fullscreen: false,
    screenRows: 6,
    onSelect: () => {},
    ...over,
  })

  async function frame(element: () => unknown): Promise<string> {
    const setup = await testRender(element as () => never, { width: 60, height: 20 })
    await setup.renderOnce()
    return setup.captureCharFrame()
  }

  // An empty box reads as a panel that failed to load. Saying what is true costs one
  // line and tells the reader the feature is simply idle.
  test('says this conversation started nothing, rather than showing an empty box', async () => {
    const text = await frame(() => sessionPanelView(view()))
    expect(text).toContain('this conversation started no PTY session')
  })

  test('names the count and the mode', async () => {
    const state = initialSessionPanelState()
    noteSessionPanelList(state, [session({ id: 'a' }), session({ id: 'b' })], ME)
    const text = await frame(() => sessionPanelView(view({ state, fullscreen: true })))
    expect(text).toContain('PTY')
    expect(text).toContain('2 sessions')
    expect(text).toContain('fullscreen')
  })

  test('says one session, not one sessions', async () => {
    const state = initialSessionPanelState()
    noteSessionPanelList(state, [session({ id: 'a' })], ME)
    const text = await frame(() => sessionPanelView(view({ state })))
    expect(text).toContain('1 session')
  })

  // The selection is marked in the text as well as by colour: a reader who cannot tell
  // the tones apart still has to see which row is on screen.
  test('marks the selected row in the text', async () => {
    const state = initialSessionPanelState()
    noteSessionPanelList(
      state,
      [session({ id: 'chosen', title: 'dev' }), session({ id: 'other' })],
      ME
    )
    noteSessionSelected(state, 'other')
    const text = await frame(() => sessionPanelView(view({ state })))
    expect(text).toContain('> ')
  })

  test('shows the screen it was given', async () => {
    const state = initialSessionPanelState()
    noteSessionPanelList(state, [session({ id: 'a' })], ME)
    noteSessionScreen(state, 'visible output', Date.now())
    const text = await frame(() => sessionPanelView(view({ state })))
    expect(text).toContain('visible output')
  })

  // The only interaction this panel has. Everything else about it is a limit of the SDK,
  // so a row that cannot be clicked would leave the panel with no way to change its mind
  // at all - and no other test would notice, because every one of them sets the selection
  // directly.
  test('clicking a row selects it, through the real dispatch', async () => {
    const state = initialSessionPanelState()
    noteSessionPanelList(
      state,
      [session({ id: 'first', title: 'one' }), session({ id: 'second', title: 'two' })],
      ME
    )
    const picked: string[] = []
    const setup = await testRender(
      () =>
        sessionPanelView(
          view({
            state,
            onSelect: (id) => picked.push(id),
          })
        ) as never,
      { width: 60, height: 20 }
    )
    await setup.renderOnce()

    // Row 0 is the header, so the second session is on row 2.
    await setup.mockMouse.click(4, 2)
    await setup.renderOnce()

    expect(picked).toEqual(['second'])
  })

  test('reports focus, because a focused panel may be the one taking keys', async () => {
    const text = await frame(() => sessionPanelView(view({ focused: true })))
    expect(text).toContain('(focused)')
  })
})
