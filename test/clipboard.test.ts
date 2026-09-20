import { describe, expect, it } from 'bun:test'

import { copyTextToClipboard, type LegacyCopy } from '../src/web/client/lib/clipboard.ts'

function failingClipboard() {
  return {
    writeText: async () => {
      throw new Error('not allowed')
    },
  }
}

describe('copyTextToClipboard', () => {
  it('uses the async clipboard when it is available', async () => {
    const written: string[] = []
    const copied = await copyTextToClipboard('hello', {
      clipboard: {
        writeText: async (text) => {
          written.push(text)
        },
      },
    })

    expect(copied).toBe(true)
    expect(written).toEqual(['hello'])
  })

  it('falls back to the legacy path when the clipboard API rejects', async () => {
    const legacy: string[] = []
    const copied = await copyTextToClipboard('hello', {
      clipboard: failingClipboard(),
      legacyCopy: (text) => {
        legacy.push(text)
        return true
      },
    })

    expect(copied).toBe(true)
    expect(legacy).toEqual(['hello'])
  })

  it('reports failure when neither path works', async () => {
    const copied = await copyTextToClipboard('hello', {
      clipboard: failingClipboard(),
      legacyCopy: () => false,
    })

    expect(copied).toBe(false)
  })

  it('uses the legacy path directly when there is no async clipboard', async () => {
    const legacy: LegacyCopy = () => true
    expect(await copyTextToClipboard('hello', { clipboard: null, legacyCopy: legacy })).toBe(true)
  })

  it('does nothing for empty text', async () => {
    let called = false
    const copied = await copyTextToClipboard('', {
      clipboard: {
        writeText: async () => {
          called = true
        },
      },
    })

    expect(copied).toBe(false)
    expect(called).toBe(false)
  })
})
