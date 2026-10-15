import { describe, expect, test } from 'bun:test'
import { testRender } from '@opentui/solid'

import {
  SCROLL_SLACK_ROWS,
  startScrollKeeper,
  settleSticky,
  type ScrollCanvas,
} from '../src/tui/scroll-keeper.ts'

/**
 * Keeping the console where the reader scrolled it.
 *
 * These are the decision's own tests: pure, synchronous, no timers. The keeper's
 * interval only drives `settleSticky`, so the interval itself is never part of an
 * assertion - a poll that re-pins the view is the symptom the reader measured, and the
 * rule that stops it is a function, not a clock.
 */

const canvas = (over: Partial<ScrollCanvas> = {}): ScrollCanvas => ({
  stickyScroll: true,
  scrollTop: 0,
  scrollHeight: 40,
  viewport: { height: 20 },
  isDestroyed: false,
  ...over,
})

describe('settleSticky', () => {
  // A fresh view IS at the bottom: a screen no taller than the viewport has its top
  // scroll of nowhere to go, so it counts as pinned.
  test('keeps the pin while the reader is at the bottom', () => {
    const screen = canvas({ scrollHeight: 20, scrollTop: 0 })
    settleSticky(screen)
    expect(screen.stickyScroll).toBe(true)
    const scrolled = canvas({ scrollHeight: 60, scrollTop: 40 })
    settleSticky(scrolled)
    expect(scrolled.stickyScroll).toBe(true)
  })

  // THE reported symptom, as a rule: scroll up, and the poll may keep writing rows but
  // may not drag the view.
  test('releases the pin once the reader is away from the bottom', () => {
    const screen = canvas({ scrollTop: 0, scrollHeight: 60 })
    settleSticky(screen)
    expect(screen.stickyScroll).toBe(false)
  })

  // Two rows near the bottom are still the bottom: a small scroll should not cost the
  // pin, which is what a slack is for.
  test('counts rows below the viewport as pinned while they are within the slack', () => {
    const screen = canvas({ scrollTop: 60 - 20 - SCROLL_SLACK_ROWS, scrollHeight: 60 })
    settleSticky(screen)
    expect(screen.stickyScroll).toBe(true)
    const farther = canvas({ scrollTop: 60 - 20 - SCROLL_SLACK_ROWS - 1, scrollHeight: 60 })
    settleSticky(farther)
    expect(farther.stickyScroll).toBe(false)
  })

  // Scrolled back: the reader has returned to the latest output, so the pin resumes.
  test('takes the pin back up when the reader returns to the bottom', () => {
    const screen = canvas({ scrollTop: 5, scrollHeight: 60 })
    settleSticky(screen)
    expect(screen.stickyScroll).toBe(false)
    screen.scrollTop = 60 // the bottom, of a screen grown past the viewport
    settleSticky(screen)
    expect(screen.stickyScroll).toBe(true)
  })
})

describe('startScrollKeeper', () => {
  // arm() is what a selection change should do: a freshly selected session restarts at
  // its bottom, without waiting for the reader to scroll there.
  test('arms a released canvas', () => {
    const released = canvas({
      stickyScroll: false,
      scrollTop: 5,
      scrollHeight: 60,
    })
    const keeper = startScrollKeeper()
    keeper.attach(released)
    // attach pins a canvas that is already at the bottom only; a reader away from the
    // bottom stays where they are, which is the rule of the whole keeper.
    expect(released.stickyScroll).toBe(false)
    released.scrollTop = 48
    settleSticky(released)
    keeper.arm()
    expect(released.stickyScroll).toBe(true)
    keeper.stop()
  })

  // attach() does not move the reader: a mid-scroll canvas keeps its position, and the
  // claim's own select/openWith arm() is what hands a fresh session its bottom.
  test('attach applies the position rule without moving it', () => {
    const mid = canvas({ stickyScroll: false, scrollTop: 10, scrollHeight: 60 })
    settleSticky(mid)
    expect(mid.stickyScroll).toBe(false)
    const keeper = startScrollKeeper()
    keeper.attach(mid)
    expect(mid.stickyScroll).toBe(false)
    keeper.stop()
  })

  // arm() is the fresh-selection direction: to the bottom, and pinned there.
  test('arm moves a stale scroll to the bottom and pins', () => {
    const stale = canvas({ stickyScroll: false, scrollTop: 5, scrollHeight: 60 })
    const keeper = startScrollKeeper()
    keeper.attach(stale)
    keeper.arm()
    expect(stale.scrollTop).toBe(40)
    expect(stale.stickyScroll).toBe(true)
    keeper.stop()
  })

  // A dead canvas receives no writes: the panel closed, and the keeper's interval must
  // not reach into what is destroyed.
  test('stops watching a destroyed canvas', () => {
    const dead = canvas({ isDestroyed: true })
    const keeper = startScrollKeeper()
    keeper.attach(dead)
    // No throw, and the pose is untouched.
    expect(dead.stickyScroll).toBe(true)
    keeper.stop()
  })
})

describe('the console hands its scrollable over', () => {
  // Wired, not assumed: the frame's own ref is what the keeper ever learns about, so
  // this asserts the claim through the render, not through a call the host makes.
  test('the view hands its console to the keeper once it is drawn', async () => {
    // The view is rendered with a canvas spy; the panel state comes from the same
    // helpers the other suite uses, but a fresh file renders the tree it needs.
    const handed: unknown[] = []
    const { sessionPanelView } = await import('../src/tui/session-panel.ts')
    const {
      initialSessionPanelState,
      noteSessionPanelInput,
      noteSessionPanelList,
      noteSessionSelected,
    } = await import('../src/tui/session-panel-state.ts')
    const state = { ...initialSessionPanelState(), sessionID: 'session-1' } as ReturnType<
      typeof initialSessionPanelState
    >
    noteSessionPanelInput(state, 'session-1')
    noteSessionPanelList(
      state,
      [].map(() => ({ id: 'pty_1' }) as never),
      'session-1'
    )
    noteSessionSelected(state, 'pty_1')

    const setup = await testRender(
      () =>
        sessionPanelView({
          tones: {
            base: '#d8dee9',
            muted: '#4c566a',
            success: '#a3be8c',
            error: '#bf616a',
            border: '#3b4252',
            raised: '#242832',
          },
          state,
          live: [],
          focused: true,
          fullscreen: false,
          onClose: () => {},
          onSend: () => {},
          onSelect: () => {},
          onToggleList: () => {},
          onConsoleCanvas: (renderable: import('../src/tui/scroll-keeper.ts').ScrollCanvas) =>
            handed.push(renderable),
          parentName: () => undefined,
        } as never) as never,
      { width: 70, height: 22 }
    )
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame.split('\n')[0]).toContain('PTY')
    expect(handed.length).toBe(1)
  })
})
