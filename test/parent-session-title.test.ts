import { afterEach, describe, expect, it } from 'bun:test'

import {
  resolveParentSessionTitles,
  setParentSessionTitleResolver,
} from '../src/plugin/pty/parent-session-title.ts'

afterEach(() => {
  setParentSessionTitleResolver(null)
})

describe('resolveParentSessionTitles', () => {
  it('deduplicates ids, trims titles and reuses cached results', async () => {
    const requested: string[] = []
    setParentSessionTitleResolver({
      getTitle: async (sessionID) => {
        requested.push(sessionID)
        return sessionID === 'ses_named' ? '  Deployment work  ' : undefined
      },
    })

    expect(await resolveParentSessionTitles(['ses_named', 'ses_named', 'ses_missing'])).toEqual({
      ses_named: 'Deployment work',
    })
    expect(await resolveParentSessionTitles(['ses_named', 'ses_missing'])).toEqual({
      ses_named: 'Deployment work',
    })
    expect(requested).toEqual(['ses_named', 'ses_missing'])
  })

  it('omits deleted parents when the host lookup throws', async () => {
    setParentSessionTitleResolver({
      getTitle: async () => {
        throw new Error('session not found')
      },
    })

    expect(await resolveParentSessionTitles(['ses_deleted'])).toEqual({})
  })

  it('returns no titles when no V2 host resolver is installed', async () => {
    expect(await resolveParentSessionTitles(['ses_parent'])).toEqual({})
  })
})
