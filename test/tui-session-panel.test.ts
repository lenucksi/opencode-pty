import { describe, expect, test } from 'bun:test'
import type { TestRendererSetup } from '@opentui/core/testing'
import { testRender } from '@opentui/solid'

import type { PanelSession } from '../src/tui/lib.ts'
import { type SessionPanelView, sessionPanelView } from '../src/tui/session-panel.ts'
import {
  initialSessionPanelState,
  LOADING_SCREEN,
  NO_SELECTION_SCREEN,
  noteScopeChosen,
  noteSessionListToggled,
  noteSessionPanelInput,
  noteSessionPanelList,
  noteSessionScreen,
  noteSessionSelected,
  selectedLive,
  selectedSession,
  sessionsForSession,
} from '../src/tui/session-panel-state.ts'

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

  // The measured failure this scope exists for: the sidebar lists PTYs from EVERY project, so a
  // row can name a conversation this panel's session is not - and filtering by the panel's own
  // session then listed NOTHING for it, in every tab. `ses_ed48fd0ce…`, a davx5 session from the day
  // before, was the parent of seven runs the sidebar showed and no panel could.
  test('lists the conversation a click named, not the panel\u2019s own session', () => {
    const state = initialSessionPanelState()
    noteSessionPanelInput(state, ME)
    noteScopeChosen(state, OTHER)
    noteSessionPanelList(
      state,
      [
        session({ id: 'mine', parentSessionId: ME }),
        session({ id: 'theirs', parentSessionId: OTHER }),
      ],
      ME
    )
    expect(state.sessions.map((entry) => entry.id)).toEqual(['theirs'])
  })

  // THE poll twitch, as a state rule: every tick calls this with a fresh list the SERVER
  // built, and handing the same CONTENT a new array object makes whatever watches the
  // store treat every row as changed - which is the reader's measured twitch. Identical
  // content keeps its identity; only a changed row is re-handed.
  test('keeps the rows’ identity when the list is the same content twice', () => {
    const state = initialSessionPanelState()
    const row = () => session({ id: 'a', title: 'one', lineCount: 3 })
    noteSessionPanelInput(state, ME)
    noteSessionPanelList(state, [row()], ME)
    const first = state.sessions
    noteSessionPanelList(state, [row()], ME)
    expect(state.sessions).toBe(first)
  })

  // The converse of the merge: rows that changed ARE replaced, so a watcher of that one
  // row still learns (of the change) and the rest keep theirs.
  test('replaces only the row that changed', () => {
    const state = initialSessionPanelState()
    noteSessionPanelInput(state, ME)
    noteSessionPanelList(
      state,
      [session({ id: 'a', title: 'one' }), session({ id: 'b', title: 'two' })],
      ME
    )
    const before = state.sessions
    noteSessionPanelList(
      state,
      [session({ id: 'a', title: 'one' }), session({ id: 'b', title: 'two again' })],
      ME
    )
    const after = state.sessions
    expect(after[0]).toBe(before[0])
    expect(after[1]).not.toBe(before[1])
    expect(after[1]?.title).toBe('two again')
  })

  // A palette open means "this conversation", so the scope a click set has to go.
  test('goes back to its own conversation when the scope is cleared', () => {
    const state = initialSessionPanelState()
    noteSessionPanelInput(state, ME)
    noteScopeChosen(state, OTHER)
    noteSessionPanelList(state, [session({ id: 'theirs', parentSessionId: OTHER })], ME)
    noteScopeChosen(state, null)
    noteSessionPanelList(
      state,
      [
        session({ id: 'mine', parentSessionId: ME }),
        session({ id: 'theirs', parentSessionId: OTHER }),
      ],
      ME
    )
    expect(state.sessions.map((entry) => entry.id)).toEqual(['mine'])
  })

  // A read that lands after the reader moved on must not overwrite what they are now
  // looking at.
  test('is ignored when nothing is selected', () => {
    const state = initialSessionPanelState()
    noteSessionScreen(state, 'orphan read', 1)
    expect(state.screen).not.toBe('orphan read')
  })
})

describe('sessionPanelView', () => {
  const view = (over: Partial<Parameters<typeof sessionPanelView>[0]> = {}): SessionPanelView => ({
    tones,
    state: initialSessionPanelState(),
    live: [],
    focused: false,
    fullscreen: false,
    onClose: () => {},
    onSend: () => {},
    onSelect: () => {},
    onToggleList: () => {},
    // No host lookup in a frame case: a session with a parent then says `started by <id>`, which is
    // the fallback the line is built to fall back to.
    parentName: () => undefined,
    ...over,
  })

  /** The rendered panel's height, named because a case below asserts against a row of it. */
  const PANEL_ROWS = 20
  const PANEL_COLS = 60
  /** The footer's height, so the "fills the panel" case knows where the frame ends. */
  const FOOTER_ROWS = 1

  async function setup(element: () => unknown): Promise<TestRendererSetup> {
    const created = await testRender(element as () => never, {
      width: PANEL_COLS,
      height: PANEL_ROWS,
    })
    await created.renderOnce()
    return created
  }

  async function frame(element: () => unknown): Promise<string> {
    return (await setup(element)).captureCharFrame()
  }

  /**
   * Click whatever the first row spells `✕ close`.
   *
   * The column comes from the rendered frame rather than a constant, so the case tests the
   * wiring wherever the header lays out - and the click goes through opentui's own dispatch
   * instead of calling the callback, which would pass even if the handler were unreachable.
   */
  async function clickCloseControl(element: () => unknown): Promise<number> {
    const rendered = await setup(element)
    const column = rendered.captureCharFrame().split('\n')[0]?.indexOf('✕') ?? -1
    if (column < 0) throw new Error('the panel header draws no close control to click')
    await rendered.mockMouse.click(column, 0)
    await rendered.renderOnce()
    return column
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
    // FOLDED open first: the folded list draws no rows at all, so the marker could not be
    // on screen, and asserting on a frame that shows none would never have caught a row
    // that lost its marker. The toggle row is what a folded frame shows instead.
    noteSessionListToggled(state)
    const text = await frame(() => sessionPanelView(view({ state })))
    expect(text).toContain('> ')
  })

  // The fold. Collapsed by default, because the console is the reason the panel exists
  // and every list row competes with it for the same height - the reader whose 18
  // records took a third of the panel described exactly this, not a style preference.
  //
  // Split on purpose: the CLICK test owns the wiring (opentui reaches whatever the row
  // drew and the state turns over), the RENDER test owns the presentation (what each
  // state looks like). One test doing both needs the state to be a reactive store to
  // re-render, which the host has through `context.storage.memory` and a headless unit
  // does not - and faking that here would assert a mechanism that is not on screen.
  test('folds the session list on a click, in both directions, through the real dispatch', async () => {
    const state = initialSessionPanelState()
    noteSessionPanelList(
      state,
      [session({ id: 'first', title: 'one' }), session({ id: 'second', title: 'two' })],
      ME
    )
    expect(state.listExpanded).toBe(false)

    const setup = await testRender(
      () =>
        sessionPanelView(
          view({ state, onToggleList: () => noteSessionListToggled(state) })
        ) as never,
      { width: 60, height: 20 }
    )
    await setup.renderOnce()

    // The fold row's Y comes from the FRAME, not from a constant. The list moved to the
    // bottom of the panel, so a constant taken from the top would click the console, and
    // the fold would look dead when it was simply not on row 1 any more - the same reason
    // `clickCloseControl` reads its column from the frame.
    const foldRow = (): { y: number } => {
      const open = 'expand'
      const closed = 'collapse'
      for (const [y, line] of setup.captureCharFrame().split('\n').entries()) {
        if (line.includes(open) || line.includes(closed)) {
          return { y }
        }
      }
      throw new Error('no fold row on the frame')
    }

    // Clicking the fold row turns the state over, and that is what this test can measure:
    // the headless render holds the tree it drew first, so the frame below stays a
    // snapshot of the folded list even after the click lands - which is why a frame
    // assertion here would always say "expand" and look like a dead fold. What the
    // states LOOK like is the next test's claim, on a state rendered as it is.
    await setup.mockMouse.click(2, foldRow().y)
    await setup.renderOnce()
    expect(state.listExpanded).toBe(true)

    await setup.mockMouse.click(2, foldRow().y)
    await setup.renderOnce()
    expect(state.listExpanded).toBe(false)
  })

  test('the folded list shows only the fold row, an open one the rows', async () => {
    const state = initialSessionPanelState()
    noteSessionPanelList(
      state,
      [session({ id: 'first', title: 'one' }), session({ id: 'second', title: 'two' })],
      ME
    )
    const folded = await frame(() => sessionPanelView(view({ state })))
    expect(folded).toContain('▸')
    expect(folded).toContain('(expand)')
    expect(folded).not.toContain('two')

    const open = initialSessionPanelState()
    open.listExpanded = true
    noteSessionPanelList(open, [session({ id: 'second', title: 'two' })], ME)
    const openFrame = await frame(() => sessionPanelView(view({ state: open })))
    expect(openFrame).toContain('▾')
    expect(openFrame).toContain('two')
  })

  test('marks the selected row in the text, once the list is open', async () => {
    const state = initialSessionPanelState()
    noteSessionPanelList(
      state,
      [session({ id: 'chosen', title: 'dev' }), session({ id: 'other' })],
      ME
    )
    noteSessionSelected(state, 'other')
    // FOLDED open first: the folded list draws no rows at all, so the marker could not
    // even be ON screen, and a frame that shows none can never catch a row that lost its
    // marker. The toggle row is what a folded frame shows instead.
    noteSessionListToggled(state)
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
    state.listExpanded = true
    noteSessionPanelList(
      state,
      [session({ id: 'first', title: 'one' }), session({ id: 'second', title: 'two' })],
      ME
    )
    const picked: string[] = []
    // The list renders EXPANDED here because which rows exist is the fold tests' claim;
    // this one owns where a row click travels once the rows are drawn.
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

    // The rows come from the FRAME rather than from an assumed order: two sessions with
    // equal timestamps are ordered by a tie rule this test does not own, and assuming
    // "first is on row 2" would make the test pass on whichever order the sort produced
    // instead of on the click reaching what was drawn.
    const frameRow = (word: string): number => {
      const row = setup
        .captureCharFrame()
        .split('\n')
        .findIndex((l) => l.includes(word))
      if (row < 0) throw new Error(`the frame drew no row containing ${word}`)
      return row
    }
    await setup.mockMouse.click(4, frameRow('two'))
    await setup.renderOnce()
    expect(picked).toEqual(['second'])
  })

  test('folding the list open shows the rows and folds it closed again', async () => {
    const state = initialSessionPanelState()
    noteSessionPanelList(
      state,
      [session({ id: 'first', title: 'one' }), session({ id: 'second', title: 'two' })],
      ME
    )
    const text = await frame(() => sessionPanelView(view({ state })))
    expect(text).not.toContain('▶')
    expect(text).toContain('▸')
    expect(text).not.toContain('two')

    const open = initialSessionPanelState()
    open.listExpanded = true
    noteSessionPanelList(open, [session({ id: 'second', title: 'two' })], ME)
    const expandedText = await frame(() => sessionPanelView(view({ state: open })))
    expect(expandedText).toContain('▾')
    expect(expandedText).toContain('two')
  })

  test('reports focus, because a focused panel may be the one taking keys', async () => {
    const text = await frame(() => sessionPanelView(view({ focused: true })))
    expect(text).toContain('(focused)')
  })

  // ------------------------------------------------------------------------------------
  // The way out. This panel shipped with none: the host has no key for closing a plugin
  // panel, and every route the reader has - change session, pick a terminal, open the
  // sidebar - is a different action that happens to close it as a side effect. So opening
  // `/pty-sessions` left a reader with a panel they could not leave, and the only thing
  // that worked was killing the terminal. Reported by a reader, measured here.
  // ------------------------------------------------------------------------------------

  // A control nobody has been told about is not an exit, so it says what it does.
  test('offers a close control that names itself', async () => {
    const text = await frame(() => sessionPanelView(view()))
    expect(text).toContain('✕ close')
  })

  // Dispatched through opentui, so this fails if the handler is unreachable rather than
  // passing because a callback was invoked directly. One click, one call: a click delivers
  // a mouse-down AND a mouse-up, so a handler on each would fire twice.
  test('the close control closes the panel, once per click', async () => {
    let closes = 0
    const element = () => sessionPanelView(view({ onClose: () => closes++ }))
    await clickCloseControl(element)
    expect(closes).toBe(1)
  })

  // A large empty black rectangle says nothing, and next to the sentence explaining why
  // there is nothing it reads as a rendering failure rather than as an absence.
  test('draws no framed screen box while nothing is selected', async () => {
    const text = await frame(() => sessionPanelView(view()))
    expect(text).toContain('this conversation started no PTY session')
    expect(text).not.toContain('┌')
  })

  // The screen box grows into the panel instead of claiming a row count. The first version
  // computed half of `renderer.height` - the TERMINAL's height - and asked for it inside a
  // panel far smaller, which overflowed the session view rather than filling it; a reader
  // reported the panel ignoring the available length. Growing is both correct and what the
  // host's own terminal pane does (panel-host.tsx:26-31).
  test('the framed screen reaches the last row of the panel', async () => {
    const state = initialSessionPanelState()
    noteSessionPanelList(state, [session({ id: 'a' })], ME)
    noteSessionSelected(state, 'a')
    noteSessionScreen(state, 'line one', 1)
    const lines = (await frame(() => sessionPanelView(view({ state })))).split('\n')
    const bottom = lines.findIndex((line) => line.startsWith('└'))
    // LAST is the list's folded header row, then the footer. Naming the three heights is
    // the point: a screen box with a fixed height also ends its frame somewhere and leaves
    // blank rows under it, so "the frame is the last thing drawn" would pass on exactly
    // the code that is wrong here. The list is folded by default, so it is one row.
    expect(bottom).toBe(PANEL_ROWS - FOOTER_ROWS - 1 - 1)
  })

  // The footer and the send control. Both exist because a screen with no numbers on it
  // cannot answer "is this stale?", and a view that only shows output cannot be used.
  test('the footer names the session, its size and its counters', async () => {
    const state = initialSessionPanelState()
    noteSessionPanelList(state, [session({ id: 'pty_9', cols: 120, rows: 40, lineCount: 812 })], ME)
    noteSessionSelected(state, 'pty_9')
    noteSessionScreen(state, 'one\ntwo\nthree', 1)
    const text = await frame(() =>
      sessionPanelView(
        view({ state, live: [session({ id: 'pty_9', cols: 120, rows: 40, lineCount: 812 })] })
      )
    )
    expect(text).toContain('pty_9')
    // The size a full-screen program was actually given: `top` at 120x40 wrapped into 80
    // columns is a different program, not a rendering fault.
    expect(text).toContain('120x40')
    expect(text).toContain('lines 812')
    expect(text).toContain('screen 3 rows')
  })

  // Nothing selected means nothing to report; a footer full of placeholders would be noise.
  test('the footer is empty while nothing is selected', async () => {
    const text = await frame(() => sessionPanelView(view()))
    expect(text).toContain('this conversation started no PTY session')
    expect(text).not.toContain('screen 0 rows')
  })

  test('offers a send control for a process that can still be written to', async () => {
    const state = initialSessionPanelState()
    noteSessionPanelList(state, [session({ id: 'pty_9' })], ME)
    noteSessionSelected(state, 'pty_9')
    const text = await frame(() =>
      sessionPanelView(view({ state, live: [session({ id: 'pty_9' })] }))
    )
    expect(text).toContain('⌨ send')
  })

  // A control that opens an input field the server will refuse is worse than none.
  test('hides the send control for a finished session', async () => {
    const ended = session({ id: 'pty_9', status: 'exited', exitCode: 0 })
    const state = initialSessionPanelState()
    noteSessionPanelList(state, [ended], ME)
    noteSessionSelected(state, 'pty_9')
    const text = await frame(() => sessionPanelView(view({ state, live: [ended] })))
    expect(text).not.toContain('⌨ send')
  })

  // Dispatched through opentui, so this fails if the control is unreachable. The column comes
  // from the rendered header, where `✕ send` sits left of `✕ close`.
  test('the send control hands the selected session to the action', async () => {
    const live = session({ id: 'pty_9' })
    const state = initialSessionPanelState()
    noteSessionPanelList(state, [live], ME)
    noteSessionSelected(state, 'pty_9')
    const sent: string[] = []
    const element = () =>
      sessionPanelView(view({ state, live: [live], onSend: (target) => sent.push(target.id) }))
    const rendered = await setup(element)
    const column = rendered.captureCharFrame().split('\n')[0]?.indexOf('⌨') ?? -1
    if (column < 0) throw new Error('the panel header draws no send control to click')
    // The ORDER is what keeps the dialog alive in production: asked for on the down,
    // the dialog dies on that same gesture's up - the backdrop under the pointer
    // receives the release and closes. So the up, not the down, may be what requests
    // the input, and this asserts the order rather than only reachability.
    await rendered.mockMouse.pressDown(column, 0)
    await rendered.renderOnce()
    expect(sent).toEqual([])
    await rendered.mockMouse.release(column, 0)
    await rendered.renderOnce()
    expect(sent).toEqual(['pty_9'])
  })
})
