import type { Page } from '@playwright/test'
import type { SerializeAddon } from '../../src/web/client/addons/serialize.ts'

// Global module augmentation for E2E testing. The emulator is ghostty-web now;
// the `xterm*` global names are retained for historical test compatibility.
declare global {
  interface Window {
    xtermTerminal?: import('ghostty-web').Terminal
    xtermSerializeAddon?: SerializeAddon
  }
}

/** Return lines up to (and including) the last non-empty line. */
const trimToLastNonEmpty = (lines: string[]): string[] => {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i] !== '') {
      return lines.slice(0, i + 1)
    }
  }
  return []
}

/**
 * Plain-text view of the terminal, backed by the canonical SerializeAddon
 * extractor. ghostty-web is canvas-only (there is no `.xterm-rows` DOM text
 * layer), so DOM scraping is not possible; the serialize addon is the single
 * source of truth for terminal content in the E2E suite.
 */
export const getTerminalPlainText = async (page: Page): Promise<string[]> => {
  const serialized = await getSerializedContentByXtermSerializeAddon(page, {
    excludeModes: true,
    excludeAltBuffer: true,
  })
  if (!serialized) return []
  const lines = Bun.stripANSI(serialized).replaceAll('\r', '').split('\n')
  return trimToLastNonEmpty(lines)
}

/**
 * Content lines read directly from the emulator's buffer API
 * (`window.xtermTerminal.buffer.active`). This is an extraction path
 * independent of the SerializeAddon and is used to cross-check it.
 */
export const getTerminalBufferLines = async (page: Page): Promise<string[]> => {
  return await page.evaluate(() => {
    const term = window.xtermTerminal
    const buffer = term?.buffer?.active
    if (!buffer) return []

    const lines: string[] = []
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i)
      lines.push(line ? line.translateToString() : '')
    }

    // Return only lines up to the last non-empty line, matching the
    // SerializeAddon-based helper's trimming behaviour.
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i] !== '') {
        return lines.slice(0, i + 1)
      }
    }
    return []
  })
}

export const getSerializedContentByXtermSerializeAddon = async (
  page: Page,
  { excludeModes = false, excludeAltBuffer = false } = {}
): Promise<string> => {
  return await page.evaluate(
    (opts) => {
      const serializeAddon = window.xtermSerializeAddon
      if (!serializeAddon) return ''
      return serializeAddon.serialize({
        excludeModes: opts.excludeModes,
        excludeAltBuffer: opts.excludeAltBuffer,
      })
    },
    { excludeModes, excludeAltBuffer }
  )
}

/**
 * Robust, DRY event-driven terminal content waiter for Playwright E2E
 * Waits for regex pattern to appear in xterm.js SerializeAddon buffer.
 * Throws an error if SerializeAddon or Terminal is not available.
 * Usage: await waitForTerminalRegex(page, /pattern/)
 */
export const waitForTerminalRegex = async (
  page: Page,
  regex: RegExp,
  serializeOptions: { excludeModes?: boolean; excludeAltBuffer?: boolean } = {
    excludeModes: true,
    excludeAltBuffer: true,
  },
  timeout: number = 5000
): Promise<void> => {
  // First, ensure the serialize addon is available (with a reasonable timeout)
  await page.waitForFunction(() => window.xtermSerializeAddon !== undefined, { timeout: 10000 })

  let timeoutId: NodeJS.Timeout | undefined
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('Timeout waiting for terminal regex')), timeout)
  })

  const evaluatePromise = page.evaluate(
    (args) => {
      const { pattern, excludeModes, excludeAltBuffer } = args
      const term = window.xtermTerminal
      const serializeAddon = window.xtermSerializeAddon

      if (!serializeAddon) {
        throw new Error('SerializeAddon not available on window')
      }

      if (!term) {
        throw new Error('Terminal not found on window')
      }

      // Browser-compatible stripAnsi implementation
      function stripAnsi(str: string): string {
        return str.replace(
          // biome-ignore lint/suspicious/noControlCharactersInRegex: Intentional control characters for ANSI escape sequence stripping
          /[\u001B\u009B][[()#;?]*(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007|(?:\d{1,4}(?:;\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~])/g,
          ''
        )
      }

      function checkMatch(serializeAddon: SerializeAddon): boolean {
        const content = serializeAddon.serialize({
          excludeModes,
          excludeAltBuffer,
        })
        try {
          const plain = stripAnsi(content.replaceAll('\r', ''))
          return new RegExp(pattern).test(plain)
        } catch {
          return false
        }
      }

      return new Promise<boolean>((resolve) => {
        // ghostty-web has no `onWriteParsed` event, so poll the serialized
        // buffer instead. The emulator parses writes synchronously, so this is
        // an accurate (if slightly less event-driven) readiness signal.
        let done = false
        let intervalId: ReturnType<typeof setInterval> | undefined
        const finish = () => {
          if (done) return
          done = true
          if (intervalId !== undefined) clearInterval(intervalId)
          resolve(true)
        }
        const check = () => {
          if (checkMatch(serializeAddon)) finish()
        }
        intervalId = setInterval(check, 50)

        // Immediate check
        check()
      })
    },
    {
      pattern: regex.source,
      excludeModes: serializeOptions.excludeModes,
      excludeAltBuffer: serializeOptions.excludeAltBuffer,
    }
  )

  try {
    await Promise.race([evaluatePromise, timeoutPromise])
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId)
    }
  }
}
