import { describe, expect, test } from 'bun:test'
import type { TestRendererSetup } from '@opentui/core/testing'
import { testRender } from '@opentui/solid'
import type { Plugin } from '@opencode/plugin/tui'

import {
  KEY_ACTIONS,
  openSendDialog,
  toLinePayload,
  type SendChoice,
} from '../src/tui/send-dialog.ts'

/**
 * The send dialog's own decisions: what one of its buttons sends, and how it walks
 * away. The bytes are data (`KEY_ACTIONS`) rather than behaviour, so they are asserted
 * as the table they are; the gestures are dispatched through opentui like every other
 * click this suite tests.
 */

const tones = {
  base: '#d8dee9',
  muted: '#4c566a',
  success: '#a3be8c',
  error: '#bf616a',
  border: '#3b4252',
  raised: '#242832',
}

/** The control bytes, spelled in JavaScript escapes rather than raw characters. */
const BYTES = { ETX: '\u0003', EOT: '\u0004', SUB: '\u001a', ESC: '\u001b' }

describe('KEY_ACTIONS', () => {
  // Each byte is asserted literally so the table cannot drift into what a terminal
  // driver would not read.
  test('carries the control byte each label names', () => {
    const bytes = new Map(KEY_ACTIONS.map((action) => [action.label, action.bytes]))
    expect(bytes.get('Ctrl+C')).toBe(BYTES.ETX)
    expect(bytes.get('Ctrl+D')).toBe(BYTES.EOT)
    expect(bytes.get('Ctrl+Z')).toBe(BYTES.SUB)
    expect(bytes.get('Esc')).toBe(BYTES.ESC)
    expect(bytes.get('Tab')).toBe('\t')
    expect(bytes.get('Enter')).toBe('\r')
  })

  // Enter is a carriage return, never a newline: the line discipline turns one into
  // what a program reads as Enter.
  test('names six labels without duplicates', () => {
    expect(KEY_ACTIONS.length).toBe(6)
    expect(new Set(KEY_ACTIONS.map((action) => action.label)).size).toBe(6)
  })
})

describe('toLinePayload', () => {
  // The reader types `q` and means the key.
  test('appends one carriage return', () => {
    expect(toLinePayload('q')).toBe('q\r')
  })

  // A deliberate empty enter is still possible, and an already-terminated line is
  // never terminated twice.
  test('sends a bare enter and leaves a terminated line as it stands', () => {
    expect(toLinePayload('')).toBe('\r')
    expect(toLinePayload('\r')).toBe('\r')
  })
})

describe('the send dialog', () => {
  /** The layers the component registered, as factories, plus what it drew. */
  type Captures = {
    element: () => unknown
    choices: (SendChoice | undefined)[]
    clears: () => number
    /** The layer factories the component handed the keymap, in order. */
    layers: (() => { commands?: { run?: () => void }[] })[]
  }

  /** A context with just what `openSendDialog` touches, plus what it recorded. */
  const openComfortably = (): Captures => {
    const choices: (SendChoice | undefined)[] = []
    let clears = 0
    let captured: (() => unknown) | undefined
    const layers: Captures['layers'] = []
    const context = {
      ui: {
        dialog: {
          show: (render: () => unknown): void => {
            captured = render
          },
          set: (): void => {},
          clear: (): void => {
            clears += 1
          },
          prompt: async (): Promise<string | undefined> => undefined,
        },
      },
      // A RECORDING keymap, not a no-op: the layers carry the submit and escape
      // behaviour, and a test that exercises them must be able to pull them out.
      keymap: {
        layer: (build: () => { commands?: { run?: () => void }[] }): void => {
          layers.push(build)
        },
      } as unknown as Plugin.Context['keymap'],
      renderer: {
        getSelection: (): unknown => undefined,
        clearSelection: (): void => {},
      } as unknown as Plugin.Context['renderer'],
    } as unknown as Plugin.Context
    void openSendDialog(context, {
      tones,
      title: 'Send to owrt console 2',
      description: 'keys send at once.',
    }).then((choice) => choices.push(choice))
    if (captured === undefined) throw new Error('the host never asked the dialog to render')
    return { element: captured, choices, clears: () => clears, layers }
  }

  const clickLabel = async (setup: TestRendererSetup, needle: string): Promise<void> => {
    for (const [y, line] of setup.captureCharFrame().split('\n').entries()) {
      const x = line.indexOf(needle)
      if (x >= 0) {
        await setup.mockMouse.click(x, y)
        await setup.renderOnce()
        // The headless pipeline flushes settlements after the dispatcher's tick; the
        // gesture awaits that flush like every caller in the plugin does.
        await Bun.sleep(5)
        return
      }
    }
    throw new Error(`the dialog draws no ${needle}`)
  }

  /** The run the component handed the keymap, submitted first, escape second. */
  const layerRuns = (captures: Captures): (() => void)[] => {
    const runs: (() => void)[] = []
    for (const build of captures.layers) {
      for (const command of build().commands ?? []) {
        if (command.run) runs.push(command.run)
      }
    }
    return runs
  }

  // One rendered dialog, several gestures: the headless renderer holds the tree it drew
  // first, so a widget that production would tear down stays seated here - which is
  // what makes the settle-once guard assertable at all.
  test('a chip sends exactly its bytes, then a later gesture settles nothing', async () => {
    const captures = openComfortably()
    const setup = await testRender(captures.element as () => never, { width: 74, height: 12 })
    await setup.renderOnce()
    // The mount's focus settles one tick after the field exists - waiting is what lets
    // that branch run, rather than asserting before the dialog had done its own work.
    await Bun.sleep(30)

    // The layers' own decisions, exercised directly: the submit run walks out at an
    // EMPTY field (a press of nothing; the Enter chip is how a bare enter is sent), and
    // the escape run walks it out.
    const runs = layerRuns(captures)
    expect(runs).toHaveLength(2)
    const submitRun = runs[0]
    const escapeRun = runs[1]
    if (submitRun === undefined || escapeRun === undefined) throw new Error('a layer without a run')
    submitRun()
    expect(captures.choices).toEqual([])
    expect(captures.clears()).toBe(0)
    escapeRun()
    expect(captures.choices).toEqual([undefined])
    expect(captures.clears()).toBe(1)

    // Settled: a chip thereafter answers and closes NOTHING further. In production the
    // closed dialog is gone rather than clickable, so the honest counterpart of that
    // here is the guard - and not a second close.
    await clickLabel(setup, 'Ctrl+C')
    expect(captures.choices).toEqual([undefined])
    expect(captures.clears()).toBe(1)
  })

  // The reader's exit: click the dialog's own close while nothing is settled yet, and
  // the choice is undefined - nothing is sent, the field is not a final submit.
  test('the dialog’s own close answers undefined', async () => {
    const captures = openComfortably()
    const setup = await testRender(captures.element as () => never, { width: 74, height: 12 })
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    const row = frame.split('\n').findIndex((line) => line.includes('✕ close'))
    if (row < 0) throw new Error('the dialog draws no close control')
    const rowText = frame.split('\n')[row]
    if (rowText === undefined) throw new Error('the close row vanished between the two reads')
    const column = rowText.indexOf('✕')
    await setup.mockMouse.click(column, row)
    await setup.renderOnce()
    await Bun.sleep(5)
    expect(captures.choices.length).toBe(1)
    expect(captures.choices[0]).toBeUndefined()
    expect(captures.clears()).toBe(1)
  })
})
