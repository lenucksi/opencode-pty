import { describe, expect, test } from 'bun:test'
import { RGBA } from '@opentui/core'
import { testRender } from '@opentui/solid'

import type { PanelSession } from '../src/tui/lib.ts'
import {
  clearTargetCount,
  dialogRows,
  dialogSize,
  outputDialogView,
  type PanelView,
  REMOVE_GLYPH,
  sidebarView,
} from '../src/tui/render.ts'

/**
 * What the panel draws, rendered headlessly.
 *
 * The builders take plain inputs and plain callbacks, so the element tree can be
 * built from a literal - which is the only way to assert on it without a terminal.
 */

const tones = {
  base: RGBA.fromHex('#d8dee9'),
  muted: RGBA.fromHex('#7b8494'),
  success: RGBA.fromHex('#a3be8c'),
  error: RGBA.fromHex('#bf616a'),
  border: RGBA.fromHex('#3b4252'),
  raised: RGBA.fromHex('#242832'),
}

const session = (over: Partial<PanelSession> = {}): PanelSession => ({ id: 'pty_1', ...over })

interface Handlers {
  onToggle: () => void
  onToggleArchive: () => void
  onToggleGroup: (key: string) => void
  onClear: () => void
  onOpen: (session: PanelSession) => void
  onRemove: (session: PanelSession) => void
}

const handlers = (): Handlers & { calls: string[] } => {
  const calls: string[] = []
  return {
    calls,
    onToggle: () => calls.push('toggle'),
    onToggleArchive: () => calls.push('archive'),
    onToggleGroup: (key) => calls.push(`group:${key}`),
    onClear: () => calls.push('clear'),
    onOpen: (s) => calls.push(`open:${s.id}`),
    onRemove: (s) => calls.push(`remove:${s.id}`),
  }
}

const view = (over: Partial<PanelView> = {}): PanelView => {
  const sessions = over.sessions ?? []
  return {
    tones,
    collapsed: false,
    // A fixed fixture default, not derived from `sessions`: the status is a separate
    // input the real panel computes, and a test about the header should not have to
    // state a count to see a count.
    status: '2 sessions',
    sessions,
    // Defaults to whatever the caller handed over, so a test that only cares about one
    // row does not also have to assert that the row is visible. A test ABOUT the filter
    // passes `visible` itself and says which rows it expects to survive.
    visible: over.visible ?? sessions,
    // Empty by default: a heading falls back to the stable session id until a test names a
    // title, so a case about rows and not about titles does not have to invent one.
    titles: over.titles ?? {},
    collapsedGroups: over.collapsedGroups ?? [],
    showFinished: over.showFinished ?? false,
    ...handlers(),
    ...over,
  }
}

/** Render an element and return the character frame. */
async function frame(element: () => unknown, width = 60, height = 16): Promise<string> {
  const setup = await testRender(element as () => never, { width, height })
  await setup.renderOnce()
  return setup.captureCharFrame()
}

/** The frame's line carrying `needle`, so a heading can be asserted where it is drawn. */
function lineWith(text: string, needle: string): string | undefined {
  return text.split('\n').find((line) => line.includes(needle))
}

describe('sidebarView', () => {
  test('draws the header with the panel name, chevron and status', async () => {
    const text = await frame(() => sidebarView(view({ collapsed: true })))
    expect(text).toContain('PTY')
    expect(text).toContain('2 sessions')
    // Collapsed, so the chevron offers to expand.
    expect(text).toContain('▶')
  })

  test('points the chevron the other way once expanded', async () => {
    const text = await frame(() => sidebarView(view({ collapsed: false })))
    expect(text).toContain('▼')
  })

  test('draws one row per session, with what the row says', async () => {
    const text = await frame(() =>
      sidebarView(
        view({
          status: '2 sessions',
          sessions: [
            session({ id: 'a', title: 'dev-server', status: 'running', lineCount: 120 }),
            session({ id: 'b', title: 'build', status: 'exited', exitCode: 1 }),
          ],
        })
      )
    )
    expect(text).toContain('dev-server')
    expect(text).toContain('120L')
    expect(text).toContain('build')
    expect(text).toContain('exit 1')
  })

  test('draws no rows while collapsed, even with sessions behind it', async () => {
    const text = await frame(() =>
      sidebarView(
        view({ collapsed: true, sessions: [session({ title: 'hidden', status: 'running' })] })
      )
    )
    expect(text).not.toContain('hidden')
  })

  // A finished record is not a row. With the archive collapsed the body says what is
  // true - nothing is running - rather than rendering an empty box, which reads as a
  // panel that failed to load. The count of finished sessions is the footer's job.
  test('says nothing is running rather than showing an empty box', async () => {
    const text = await frame(() =>
      sidebarView(
        view({
          status: '200 sessions',
          sessions: [session({ id: 'a', status: 'exited', exitCode: 0 })],
          visible: [],
        })
      )
    )
    expect(text).toContain('nothing running')
    expect(text).not.toContain('(none)')
  })

  // A header offering to clear nothing is a control that invites a click with no
  // answer, and reads as though it would touch live sessions.
  test('offers no clear action when nothing is finished', async () => {
    const text = await frame(() =>
      sidebarView(view({ sessions: [session({ status: 'running' })] }))
    )
    expect(text).not.toContain('clear finished')
  })

  test('offers the clear action once something is finished', async () => {
    const text = await frame(() =>
      sidebarView(view({ sessions: [session({ status: 'exited', exitCode: 0 })] }))
    )
    expect(text).toContain('clear finished')
  })

  test('truncates a long title so the state stays visible', async () => {
    const text = await frame(() =>
      sidebarView(
        view({
          sessions: [session({ title: 'x'.repeat(80), status: 'running', lineCount: 42 })],
        })
      )
    )
    expect(text).toContain('…')
    expect(text).toContain('42L')
  })

  test('renders the remove control on every row', async () => {
    const text = await frame(() =>
      sidebarView(view({ sessions: [session({ id: 'a', status: 'running' })] }))
    )
    expect(text).toContain(REMOVE_GLYPH.trim())
  })
})

/**
 * The group headings, rendered headlessly.
 *
 * The order and the fold decision are `panel-state`'s own cases; these pin what the view
 * does with them - the heading text, the fallback for a conversation that is gone, and where
 * a chevron appears at all.
 */
describe('sidebarView group headings', () => {
  const parented = (id: string, parent: string, over: Partial<PanelSession> = {}): PanelSession =>
    session({ id, status: 'running', parentSessionId: parent, ...over })

  // AC #1/#2/#3/#4: one heading per conversation, titled from the host's list when it has
  // it, and from the SHARED fallback when the conversation is gone or the session has none.
  test('heads each parent conversation with its title, or the shared fallback', async () => {
    const text = await frame(() =>
      sidebarView(
        view({
          sessions: [
            parented('a', 'ses_build', { title: 'dev-server' }),
            parented('b', 'ses_gone', { title: 'build' }),
            session({ id: 'c', title: 'manual', status: 'running' }),
          ],
          titles: { ses_build: 'Deployment work' },
        })
      )
    )
    expect(text).toContain('Deployment work')
    // A conversation that is gone falls back to the stable id, not to nothing.
    expect(text).toContain('Session ses_gone')
    // A session nobody's conversation started is still reachable (AC #6).
    expect(text).toContain('Ungrouped')
  })

  // AC #7: the agent is the raw name the web sidebar shows beside its heading, not a second
  // format invented here.
  test('shows the agent that started a group beside its heading', async () => {
    const text = await frame(() =>
      sidebarView(
        view({
          sessions: [parented('a', 'ses_build', { parentAgent: 'architect' })],
          titles: { ses_build: 'Deployment work' },
        })
      )
    )
    expect(lineWith(text, 'Deployment work')).toContain('architect')
  })

  // The host's own rule: a group of one or two is never folded, so a chevron there would be
  // a control that cannot fold anything - and the rows stay on screen.
  test('draws no fold chevron on a group of one or two, and keeps its rows', async () => {
    const text = await frame(() =>
      sidebarView(
        view({
          sessions: [
            parented('a', 'ses_one', { title: 'first' }),
            parented('b', 'ses_one', { title: 'second' }),
          ],
        })
      )
    )
    const heading = lineWith(text, 'Session ses_one')
    expect(heading).toBeDefined()
    expect(heading).not.toContain('▶')
    expect(heading).not.toContain('▼')
    expect(text).toContain('first')
    expect(text).toContain('second')
  })

  test('folds a group of more than two on its chevron, open by default', async () => {
    const three = ['a', 'b', 'c'].map((id, index) =>
      parented(id, 'ses_big', { title: `run-${index}` })
    )

    const open = await frame(() => sidebarView(view({ sessions: three })))
    expect(lineWith(open, 'Session ses_big')).toContain('▼')
    expect(open).toContain('run-0')

    const folded = await frame(() =>
      sidebarView(view({ sessions: three, collapsedGroups: ['ses_big'] }))
    )
    expect(lineWith(folded, 'Session ses_big')).toContain('▶')
    expect(folded).not.toContain('run-0')
  })

  // AC #4: a group holding a running session is drawn above one that only finished. The
  // partition is `groupsForDisplay`'s and has its own state-level case; this pins that the
  // view draws the groups in the order it is given rather than in the input's order.
  //
  // The finished session is NEWER on purpose: the shared time order alone would put it
  // first, so only the liveness partition can produce the expected order. Fixtures with
  // equal or conveniently-ordered timestamps pass whether the partition exists or not.
  test('draws a group holding a running session above one that only finished', async () => {
    const dead = parented('old', 'ses_dead', {
      title: 'stale',
      status: 'exited',
      exitCode: 1,
      createdAt: '2026-01-01T12:00:00Z',
    })
    const live = parented('live', 'ses_live', {
      title: 'alive',
      createdAt: '2026-01-01T11:00:00Z',
    })
    const text = await frame(() =>
      sidebarView(
        view({
          showFinished: true,
          sessions: [dead, live],
          // The finished group is listed first here as well, so neither the input order nor
          // the time order can explain the result.
          visible: [dead, live],
          titles: { ses_dead: 'Finished work', ses_live: 'Live work' },
        })
      )
    )
    const lines = text.split('\n')
    const liveLine = lines.findIndex((line) => line.includes('Live work'))
    const deadLine = lines.findIndex((line) => line.includes('Finished work'))
    expect(liveLine).toBeGreaterThanOrEqual(0)
    expect(deadLine).toBeGreaterThanOrEqual(0)
    expect(liveLine).toBeLessThan(deadLine)
  })
})

describe('clearTargetCount', () => {
  test('counts only what may be cleared', () => {
    expect(
      clearTargetCount([
        session({ status: 'exited' }),
        session({ status: 'running' }),
        session({ status: 'killed' }),
        session({ status: 'killing' }),
      ])
    ).toBe(2)
  })

  test('is zero for an empty list', () => {
    expect(clearTargetCount([])).toBe(0)
  })
})

describe('dialogRows', () => {
  // The host pins a dialog's top edge a quarter of the screen down and grows it
  // downward, so height is the only shape lever; these pin what is left of the
  // screen once the chrome is subtracted.
  test('leaves the tallest box that still fits the screen', () => {
    expect(dialogRows(40)).toBe(40 - 10 - 12)
    expect(dialogRows(100)).toBe(100 - 25 - 12)
  })

  // A very short terminal would otherwise be handed a negative height, and every
  // line of output would be pushed off a screen that has none.
  test('never returns less than a usable box', () => {
    expect(dialogRows(10)).toBe(6)
    expect(dialogRows(1)).toBe(6)
    expect(dialogRows(0)).toBe(6)
  })
})

describe('dialogSize', () => {
  test('scales with the terminal width', () => {
    expect(dialogSize(140)).toBe('xlarge')
    expect(dialogSize(128)).toBe('xlarge')
    expect(dialogSize(127)).toBe('large')
    expect(dialogSize(96)).toBe('large')
    expect(dialogSize(95)).toBe('medium')
    expect(dialogSize(40)).toBe('medium')
  })
})

describe('outputDialogView', () => {
  const dialog = (over: Partial<Parameters<typeof outputDialogView>[0]> = {}) => ({
    tones,
    session: session({ id: 'pty_7', title: 'dev-server', status: 'running', pid: 42 }),
    live: session({ id: 'pty_7', title: 'dev-server', status: 'running', pid: 42 }),
    now: Date.parse('2026-01-01T10:02:30.000Z'),
    output: '',
    rows: 6,
    ...over,
  })

  test('names the session and shows its invocation', async () => {
    const text = await frame(() =>
      outputDialogView(
        dialog({
          session: session({
            id: 'pty_7',
            title: 'dev-server',
            status: 'running',
            pid: 42,
            command: 'bun',
            args: ['run', 'dev'],
            workdir: '/srv/app',
          }),
        })
      )
    )
    expect(text).toContain('dev-server')
    expect(text).toContain('pty_7')
    expect(text).toContain('bun run dev')
    expect(text).toContain('/srv/app')
    expect(text).toContain('esc to close')
  })

  test('shows the output it was given', async () => {
    const text = await frame(() => dialog2('letzte Zeile des Puffers'))
    expect(text).toContain('letzte Zeile des Puffers')
  })

  test('shows how long a running session has been up', async () => {
    const created = '2026-01-01T10:00:00.000Z'
    const text = await frame(() =>
      outputDialogView(
        dialog({
          now: Date.parse('2026-01-01T10:02:30.000Z'),
          session: session({ id: 'a', status: 'running', createdAt: created }),
          live: session({ id: 'a', status: 'running', createdAt: created }),
        })
      )
    )
    expect(text).toContain('2m 30s')
  })

  // Without exitAt a finished session would measure to "now", so a transcript read
  // an hour later would claim to have run an hour.
  test('freezes the run timer at the exit once the process has stopped', async () => {
    const created = '2026-01-01T10:00:00.000Z'
    const text = await frame(() =>
      outputDialogView(
        dialog({
          now: Date.parse('2026-01-01T11:30:00.000Z'),
          session: session({
            id: 'a',
            status: 'exited',
            exitCode: 0,
            createdAt: created,
            exitAt: '2026-01-01T10:00:05.000Z',
          }),
          live: session({
            id: 'a',
            status: 'exited',
            exitCode: 0,
            createdAt: created,
            exitAt: '2026-01-01T10:00:05.000Z',
          }),
        })
      )
    )
    expect(text).toContain('5s')
    expect(text).not.toContain('1h 30m')
  })

  // A duration nobody can compute should be absent, not shown as none.
  test('shows no timer at all when the start is unknown', async () => {
    const text = await frame(() =>
      outputDialogView(
        dialog({ session: session({ status: 'running' }), live: session({ status: 'running' }) })
      )
    )
    expect(text).not.toContain('0s')
  })

  // The line budget IS the box height, so the newest output is what lands on
  // screen. A viewport of eight rows over fifty lines must show the END, not the
  // beginning: the whole point of watching a process is its latest output.
  test('shows the newest lines of a long output, and says it cut', async () => {
    const long = Array.from({ length: 50 }, (_, n) => `zeile ${n}`).join('\n')
    const text = await frame(() => dialog2(long), 40, 14)
    expect(text).toContain('…')
    expect(text).toContain('zeile 49')
    expect(text).not.toContain('zeile 0')
  })
})

/** The dialog with output, which is the one thing every case here needs. */
function dialog2(output: string) {
  return outputDialogView({
    tones,
    session: session({ id: 'pty_7', title: 'dev-server', status: 'running' }),
    live: session({ id: 'pty_7', title: 'dev-server', status: 'running' }),
    now: Date.now(),
    output,
    rows: 6,
  })
}
