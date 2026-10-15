/**
 * Keep the console where the reader scrolled it.
 *
 * The console is a scrollbox posed `stickyScroll: true` all the time, which re-pinned
 * EVERY poll's re-written screen to the bottom: a reader who scrolled up was dragged
 * back down by the next refresh, measured and reported. The host solves exactly this
 * for its own transcript and is the reference
 * (`../opencode/packages/tui/src/routes/session/index.tsx`): sticky is not a constant,
 * it flips off as soon as the reader is away from the bottom, and flips back on when
 * they return to it.
 *
 * The decision itself is pure (`settleSticky`) so it can be tested without timers; the
 * interval below only drives it.
 */

/** What the console canvas answers, without naming opentui in every caller. */
export interface ScrollCanvas {
  /** Whether the scrollbox pins itself to the latest content. Writable. */
  stickyScroll: boolean
  /** The reader's position; writable, because a keeper test moves it like they would. */
  scrollTop: number
  readonly scrollHeight: number
  readonly viewport: { readonly height: number }

  /** True when the renderable is gone; the keeper must not write into it after. */
  readonly isDestroyed: boolean
}

/**
 * Rows of tolerance near the bottom under which "at the bottom" still counts.
 *
 * A scroll of one or two rows should not cost the reader the pin: the host keeps a
 * slack for the same reason its own transcript's `navigationSlack` exists.
 */
export const SCROLL_SLACK_ROWS = 2

/**
 * The decision one tick makes: pin only while the reader is at the bottom.
 *
 * Applied, not returned, because the caller's whole job is to hold the CANVAS's
 * current pose; the boolean outcome is observable through the canvas itself.
 */
export function settleSticky(canvas: ScrollCanvas, slack: number = SCROLL_SLACK_ROWS): void {
  const want = canvas.scrollTop >= canvas.scrollHeight - canvas.viewport.height - slack
  if (canvas.stickyScroll !== want) canvas.stickyScroll = want
}

/** How often the keeper asks whether the reader is still away from the bottom. */
export const SCROLL_KEEPER_MS = 200

/**
 * Drive `settleSticky` on the canvas that is currently on screen.
 *
 * The keeper owns no state of the panel's: it watches whatever canvas it was handed
 * and flips the pin as the reader moves. A selection change re-arms it (`arm`), which
 * pins a freshly selected session to its latest output the way a fresh screen has
 * always read.
 */
export interface ScrollKeeper {
  /** Hand over the console's scrollable. */
  attach: (canvas: ScrollCanvas) => void
  /** Pin again: after a selection change, the reader starts at the bottom. */
  arm: () => void
  stop: () => void
}

export function startScrollKeeper(): ScrollKeeper {
  let canvas: ScrollCanvas | undefined
  const tick = (): void => {
    if (canvas !== undefined && !canvas.isDestroyed) settleSticky(canvas)
  }
  const timer = setInterval(tick, SCROLL_KEEPER_MS)
  return {
    attach: (next) => {
      canvas = next
      // The same renderable arrives on every claim render, so attach arrives while the
      // reader may be mid-scroll on the PREVIOUS screen: their position rules, and
      // attach does not move it - it only applies the position's rule. A canvas that is
      // already destroyed receives no write at all.
      if (!next.isDestroyed) settleSticky(next)
    },
    arm: () => {
      // The reader has not read the fresh session: its bottom is where a screen starts.
      // So arm moves the viewport to the bottom and pins, rather than letting a stale
      // scrollTop outvote the fresh view.
      const current = canvas
      if (current === undefined || current.isDestroyed) return
      current.stickyScroll = true
      current.scrollTop = Math.max(0, current.scrollHeight - current.viewport.height)
      settleSticky(current)
    },
    stop: () => clearInterval(timer),
  }
}
