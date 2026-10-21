import { describe, expect, test } from 'bun:test'
import { testRender } from '@opentui/solid'
import type { Plugin } from '@opencode/plugin/tui'

import { openSendDialog, type SendChoice } from '../src/tui/send-dialog.ts'

/**
 * The dialog's chips at the width the dialog actually gets.
 *
 * The host gives a `medium` dialog 60 columns (`dialogWidth` in
 * `../opencode/packages/tui/src/ui/dialog.tsx`); the reader measured the last chip
 * running out at that width. The first render of this suite drew its chips at a wider
 * test width and so never saw the real one - which is why this file renders at 60 and
 * asserts every chip is drawn on a row that had room for it.
 */

const tones = {
  base: '#d8dee9',
  muted: '#4c566a',
  success: '#a3be8c',
  error: '#bf616a',
  border: '#3b4252',
  raised: '#242832',
}

describe('the send dialog at medium width', () => {
  test('draws every key chip inside the dialog, at the width the host hands one', async () => {
    let captured: (() => unknown) | undefined
    const context = {
      ui: {
        dialog: {
          show: (render: () => unknown): void => {
            captured = render
          },
          set: (): void => {},
          clear: (): void => {},
          prompt: async (): Promise<string | undefined> => undefined,
        },
      },
      keymap: { layer: (): void => {} } as unknown as Plugin.Context['keymap'],
      renderer: {
        getSelection: (): unknown => undefined,
        clearSelection: (): void => {},
      } as unknown as Plugin.Context['renderer'],
    } as unknown as Plugin.Context
    const choices: (SendChoice | undefined)[] = []
    void openSendDialog(context, {
      tones,
      title: 'Send to t',
      description: 'keys send at once.',
    }).then((choice) => choices.push(choice))
    if (captured === undefined) throw new Error('the host never asked the dialog to render')

    const setup = await testRender(captured as () => never, { width: 60, height: 14 })
    await setup.renderOnce()

    const frame = (): string => setup.captureCharFrame()
    const rows = frame().split('\n')
    const rowOf = (needle: string): number => rows.findIndex((line) => line.includes(needle))
    if (rowOf('Ctrl+C') < 0) throw new Error('the dialog draws no Ctrl+C')
    for (const label of ['Ctrl+C', 'Ctrl+D', 'Ctrl+Z', 'Esc', 'Tab', 'Enter']) {
      expect(rowOf(`${label}`)).toBeGreaterThanOrEqual(0)
    }
    // The label the reader measured, drawn COMPLETE: a chip cut at the dialog edge has
    // its box colour and padding amputated, which is the papercut even when the glyphs
    // themselves squeezèd through.
    const enterRow = rows[rowOf('Enter')]
    if (enterRow === undefined) throw new Error('the rows fixture has no Enter row')
    expect(enterRow.includes('Enter')).toBe(true)
    // The hint the row used to carry grew it past every width; the footer says it now,
    // and says it inside the same dialog.
    expect(frame().includes('enter submit')).toBe(true)
  })
})
