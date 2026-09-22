import { describe, expect, it } from 'bun:test'

import { logFileName, normalizeLogText, parseLogFormat } from '../src/web/shared/log-format.ts'

describe('parseLogFormat', () => {
  it('accepts raw and defaults everything else to plain', () => {
    expect(parseLogFormat('raw')).toBe('raw')
    expect(parseLogFormat('plain')).toBe('plain')
    expect(parseLogFormat(null)).toBe('plain')
    expect(parseLogFormat(undefined)).toBe('plain')
    expect(parseLogFormat('ansi')).toBe('plain')
  })
})

describe('normalizeLogText', () => {
  const emitted = '\u001b[31mred\u001b[0m\r\nplain\r\nlast'

  it('strips escape sequences and normalises line endings for plain text', () => {
    const text = normalizeLogText(emitted, 'plain')

    expect(text).toBe('red\nplain\nlast')
    expect(text).not.toContain('\u001b[')
    expect(text).not.toContain('\r')
  })

  it('keeps every control character for raw output', () => {
    expect(normalizeLogText(emitted, 'raw')).toBe(emitted)
  })

  it('turns a lone carriage return into a line break', () => {
    expect(normalizeLogText('progress 10%\rprogress 20%', 'plain')).toBe(
      'progress 10%\nprogress 20%'
    )
  })
})

describe('logFileName', () => {
  it('names readable text .txt and raw output .log', () => {
    expect(logFileName('pty_1234', 'plain')).toBe('pty_1234.txt')
    expect(logFileName('pty_1234', 'raw')).toBe('pty_1234.log')
  })
})
