import { describe, expect, it } from 'bun:test'
import { allStructured, match } from '../src/plugin/pty/wildcard.ts'

describe('wildcard match', () => {
  it('matches literal strings exactly', () => {
    expect(match('ls', 'ls')).toBe(true)
    expect(match('lsa', 'ls')).toBe(false)
  })

  it('supports `*` and `?` wildcards', () => {
    expect(match('git commit', 'git*')).toBe(true)
    expect(match('git', 'git?')).toBe(false)
    expect(match('gita', 'git?')).toBe(true)
  })

  it('escapes regex metacharacters in the pattern', () => {
    expect(match('a.b', 'a.b')).toBe(true)
    expect(match('axb', 'a.b')).toBe(false)
    expect(match('a+b', 'a+b')).toBe(true)
  })

  it('matches across newlines with the dot-all flag', () => {
    expect(match('a\nb', 'a*b')).toBe(true)
  })
})

describe('allStructured', () => {
  it('matches a single-token head pattern', () => {
    expect(allStructured({ head: 'ls', tail: [] }, { ls: 'allow' })).toBe('allow')
  })

  it('requires a matching tail sequence for multi-token patterns', () => {
    const patterns = { 'git push': 'deny' }
    expect(allStructured({ head: 'git', tail: ['push'] }, patterns)).toBe('deny')
    expect(allStructured({ head: 'git', tail: ['status'] }, patterns)).toBeUndefined()
  })

  it('treats `*` as a skip wildcard in the tail', () => {
    const patterns = { 'npm * install': 'ask' }
    expect(allStructured({ head: 'npm', tail: ['--global', 'install'] }, patterns)).toBe('ask')
  })

  it('prefers the last matching pattern and sorts by specificity', () => {
    const patterns = { git: 'allow', 'git push': 'deny' }
    expect(allStructured({ head: 'git', tail: ['push'] }, patterns)).toBe('deny')
  })

  it('returns undefined for no matching head', () => {
    expect(allStructured({ head: 'echo', tail: [] }, { ls: 'allow' })).toBeUndefined()
  })

  it('matches tail tokens out of order where the sequence allows', () => {
    const patterns = { 'git * push': 'ask' }
    expect(allStructured({ head: 'git', tail: ['remote', 'push'] }, patterns)).toBe('ask')
    expect(allStructured({ head: 'git', tail: ['push'] }, patterns)).toBe('ask')
    expect(allStructured({ head: 'git', tail: [] }, patterns)).toBeUndefined()
  })
})
