import { describe, expect, it } from 'bun:test'

import { MAX_KEY_TIMES, keySequence, knownKeyNames } from '../src/plugin/pty/keys.ts'

/**
 * The key table.
 *
 * The bytes are the contract with a terminal, so they are asserted literally: a
 * table nobody checks is a table that quietly disagrees with every shell.
 */
describe('named keys', () => {
  it('sends the byte a terminal sends for the plain keys', () => {
    expect(keySequence('Enter')).toBe('\r')
    expect(keySequence('Tab')).toBe('\t')
    expect(keySequence('Escape')).toBe('\x1b')
    expect(keySequence('Space')).toBe(' ')
    expect(keySequence('Backspace')).toBe('\x7f')
  })

  it('accepts the spellings a person writes', () => {
    expect(keySequence('enter')).toBe('\r')
    expect(keySequence('ENTER')).toBe('\r')
    expect(keySequence('Return')).toBe('\r')
    expect(keySequence('Esc')).toBe('\x1b')
    expect(keySequence('  Up  ')).toBe('\x1b[A')
    expect(keySequence('PgUp')).toBe('\x1b[5~')
  })

  it('sends the sequences the arrow and navigation keys are', () => {
    expect(keySequence('Up')).toBe('\x1b[A')
    expect(keySequence('Down')).toBe('\x1b[B')
    expect(keySequence('Right')).toBe('\x1b[C')
    expect(keySequence('Left')).toBe('\x1b[D')
    expect(keySequence('Home')).toBe('\x1b[H')
    expect(keySequence('End')).toBe('\x1b[F')
    expect(keySequence('Delete')).toBe('\x1b[3~')
  })

  it('turns a control combination into the control byte', () => {
    expect(keySequence('C-c')).toBe('\x03')
    expect(keySequence('c-d')).toBe('\x04')
    expect(keySequence('Ctrl-a')).toBe('\x01')
    expect(keySequence('C-z')).toBe('\x1a')
    expect(keySequence('C-space')).toBe('\x00')
  })

  it('sends the function-key sequences, short ones first', () => {
    expect(keySequence('F1')).toBe('\x1bOP')
    expect(keySequence('f4')).toBe('\x1bOS')
    expect(keySequence('F5')).toBe('\x1b[15~')
    expect(keySequence('F12')).toBe('\x1b[24~')
  })

  it('refuses a name it does not know, and says nothing it cannot back', () => {
    expect(keySequence('F13')).toBeNull()
    expect(keySequence('Hyper')).toBeNull()
    expect(keySequence('')).toBeNull()
    expect(keySequence('   ')).toBeNull()
    expect(keySequence('C-1')).toBeNull()
  })

  it('lists names for the error, not the sixteen spellings of each', () => {
    const names = knownKeyNames()
    expect(names).toContain('Enter')
    expect(names).toContain('C-c')
    expect(names).toContain('F1')
    // Every listed name has to be one the table answers, or the error lies.
    for (const name of names) expect(keySequence(name)).not.toBeNull()
  })

  it('bounds how many repeats one call may send', () => {
    expect(MAX_KEY_TIMES).toBe(100)
  })
})
