import { describe, expect, test } from 'bun:test'
import { RGBA } from '@opentui/core'
import { testRender } from '@opentui/solid'

import type { PanelSession } from '../src/tui/lib.ts'
import { groupsForDisplay } from '../src/tui/panel-state.ts'
import { dialogRows, dialogSize, outputDialogView } from '../src/tui/output-dialog.ts'
import { clearTargetCount, type PanelView, REMOVE_GLYPH, sidebarView } from '../src/tui/render.ts'

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
  raisedHigh: RGBA.fromHex('#2e3440'),
}

const session = (over: Partial<PanelSession> = {}): PanelSession => ({ id: 'pty_1', ...over })

interface Handlers {
  onToggle: () => void
  onToggleArchive: () => void
  onToggleGroup: (key: string) => void
  onClearFilter: () => void
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
    onClearFilter: () => calls.push('clear-filter'),
    onClear: () => calls.push('clear'),
    onOpen: (s) => calls.push(`open:${s.id}`),
    onRemove: (s) => calls.push(`remove:${s.id}`),
  }
}

/**
 * The inputs a case may state.
 *
 * `visible` stands in for what `visibleSessions` selected - the wiring decides that, so a case
 * about the empty list has to be able to say "the server knows these, none of them is a row".
 */
interface ViewInput {
  readonly collapsed?: boolean
  readonly status?: string
  readonly sessions?: readonly PanelSession[]
  readonly visible?: readonly PanelSession[]
  readonly titles?: Readonly<Record<string, string>>
  readonly filter?: string
  readonly collapsedGroups?: readonly string[]
  readonly showFinished?: boolean
}

const view = (input: ViewInput = {}): PanelView => {
  const sessions = input.sessions ?? []
  const visible = input.visible ?? sessions
  return {
    tones,
    collapsed: input.collapsed ?? false,
    // A fixed fixture default, not derived from `sessions`: the status is a separate input the
    // real panel computes, and a test about the header should not have to state a count to see
    // a count.
    status: input.status ?? '2 sessions',
    sessions,
    // Derived exactly as the wiring derives it, so a case states the query and gets the groups
    // the panel would draw rather than hand-building them.
    groups: groupsForDisplay(visible, input.titles ?? {}, input.filter ?? ''),
    titles: input.titles ?? {},
    filter: input.filter ?? '',
    collapsedGroups: input.collapsedGroups ?? [],
    showFinished: input.showFinished ?? false,
    ...handlers(),
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
    // The renderer's own marker (`...`), not `truncateText`'s `…`: the title is the element that
    // shrinks, so the widget is the one that knows how much room was left. Pre-clipping the string
    // as well produced two markers and a middle-truncated id.
    expect(text).toContain('...')
    // Which is the point: the title gives way, the state does not.
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

  // Measured on the author's ~36-column sidebar: the heading wrapped onto a second line
  // ("▼Session" / " ses_ed48fd0ce…  build  10"), because chevron (2) + title (22) + meta (18) came
  // to 42 columns and a text wraps by default. A heading that wraps splits the group in two.
  test('keeps a group heading on one line in a narrow sidebar', async () => {
    const sessions = Array.from({ length: 10 }, (_, index) =>
      parented(`s${index}`, 'ses_ed48fd0ce4f1a2b', {
        parentAgent: 'build',
        title: `run-${index}`,
      })
    )
    const text = await frame(() => sidebarView(view({ sessions })), 36)
    const lines = text.split('\n')
    // The group's own line, found by the agent in its meta: the panel header above it also has a
    // chevron.
    const heading = lines.findIndex((line) => line.includes('build'))
    expect(heading).toBeGreaterThanOrEqual(0)
    // One line, with the fold control and the count on it, and nothing spilled below.
    expect(lines[heading]).toContain('▼')
    expect(lines[heading]).toContain('10 sessions')
    expect(lines[heading + 1] ?? '').not.toContain('sessions')
  })

  // The state is the reason a row exists, so a narrow sidebar must cost the TITLE its tail and
  // not the row its state. Measured: below 30 columns the tail landed on a line of its own, and
  // with the row drawn from one string the state was then clipped to `1`.
  test('keeps a row on one line, and keeps its state, in a narrow sidebar', async () => {
    const text = await frame(
      () =>
        sidebarView(
          view({
            sessions: [
              session({
                id: 'a',
                status: 'running',
                lineCount: 123456,
                title: 'davx5-emu: Boot long-way round with adb',
              }),
            ],
          })
        ),
      30
    )
    const lines = text.split('\n')
    const row = lines.findIndex((line) => line.includes('123456L'))
    expect(row).toBeGreaterThanOrEqual(0)
    // The whole row on one line: bullet, state and the remove control all present.
    expect(lines[row]).toContain('•')
    expect(lines[row]).toContain('✕')
    expect(lines[row + 1] ?? '').not.toContain('123456L')
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

/**
 * The filter, in the two places a reader meets it: the header chip that clears it, and the
 * empty state that has to explain itself.
 */
describe('sidebarView with a filter', () => {
  const parented = (id: string, parent: string, over: Partial<PanelSession> = {}): PanelSession =>
    session({ id, status: 'running', parentSessionId: parent, ...over })

  // A bare "nothing running" under an active filter is a different claim from the truth: it
  // says no process is alive, when what happened is that the query excluded every one.
  test('names the query instead of claiming nothing is running', async () => {
    const text = await frame(() =>
      sidebarView(
        view({
          filter: 'kubernetes',
          sessions: [session({ id: 'a', title: 'dev-server', status: 'running' })],
        })
      )
    )
    expect(text).toContain('nothing matches “kubernetes”')
    expect(text).not.toContain('nothing running')
  })

  test('says nothing is running when no filter is set', async () => {
    const text = await frame(() =>
      sidebarView(
        view({ sessions: [session({ id: 'a', status: 'exited', exitCode: 0 })], visible: [] })
      )
    )
    expect(text).toContain('nothing running')
    expect(text).not.toContain('nothing matches')
  })

  // The shared rule: a group whose CONVERSATION matched keeps its whole group, because someone
  // searching for a conversation wants the processes it started.
  test('keeps a whole group when its conversation title matches', async () => {
    const text = await frame(() =>
      sidebarView(
        view({
          filter: 'deploy',
          sessions: [
            parented('a', 'ses_build', { title: 'compile' }),
            parented('b', 'ses_build', { title: 'link' }),
            parented('c', 'ses_other', { title: 'unrelated' }),
          ],
          titles: { ses_build: 'Deployment work', ses_other: 'Something else' },
        })
      )
    )
    expect(text).toContain('Deployment work')
    expect(text).toContain('compile')
    expect(text).toContain('link')
    expect(text).not.toContain('unrelated')
    expect(text).not.toContain('Something else')
  })

  // A child match keeps only that child, so a group is never a lie about what matched.
  test('drops the siblings a child match did not reach', async () => {
    const text = await frame(() =>
      sidebarView(
        view({
          filter: 'link',
          sessions: [
            parented('a', 'ses_build', { title: 'compile' }),
            parented('b', 'ses_build', { title: 'link' }),
          ],
          titles: { ses_build: 'Deployment work' },
        })
      )
    )
    expect(text).toContain('link')
    expect(text).not.toContain('compile')
  })

  // The route that needs no typing. Drawn only while a filter is set, so the header never
  // offers a click that would clear nothing.
  test('draws a clearable chip only while a filter is set', async () => {
    const filtered = await frame(() =>
      sidebarView(
        view({
          filter: 'build',
          sessions: [session({ id: 'a', title: 'build', status: 'running' })],
        })
      )
    )
    expect(filtered.split('\n')[0]).toContain('build ✕')

    const plain = await frame(() =>
      sidebarView(view({ sessions: [session({ id: 'a', title: 'build', status: 'running' })] }))
    )
    expect(plain.split('\n')[0]).not.toContain('✕')
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
