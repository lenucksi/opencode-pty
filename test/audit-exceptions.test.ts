/**
 * The temporary audit exceptions must expire.
 *
 * A suppression without an end date becomes permanent by neglect; the point of these
 * cases is that the same code path that tolerates an advisory today fails again on the
 * day it was supposed to be fixed.
 */

import { describe, expect, it } from 'bun:test'

import {
  activeAuditExceptions,
  TEMPORARY_AUDIT_EXCEPTIONS,
} from '../scripts/quality/dependencies.ts'

describe('temporary audit exceptions', () => {
  it('applies while the window is open', () => {
    const open = activeAuditExceptions(new Date('2026-11-17T12:00:00Z'))
    for (const entry of TEMPORARY_AUDIT_EXCEPTIONS) {
      expect(open).toContain(entry.id)
    }
  })

  it('expires on the stated day, without anyone having to edit the gate again', () => {
    const closed = activeAuditExceptions(new Date('2026-12-01T00:00:00Z'))
    expect(closed).toEqual([])
  })

  it('carries an id, a package and a written reason for every entry', () => {
    for (const entry of TEMPORARY_AUDIT_EXCEPTIONS) {
      expect(entry.id).toMatch(/^GHSA-/)
      expect(entry.package).not.toBe('')
      expect(entry.reason.length).toBeGreaterThan(40)
      expect(entry.expires).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })
})
