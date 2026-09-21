import { describe, expect, it, mock } from 'bun:test'

import type { PtyLogger } from '../src/plugin/pty/plugin-log.ts'
import { Plugin } from '../src/v2/index.ts'
import { PTY_USAGE_SKILL_ID, registerUsageSkill } from '../src/v2/skill.ts'
import type { PluginContextV2, SkillDraft, SkillEditorEntryV2 } from '../src/v2/types.ts'

/**
 * The host disables a plugin whose transform throws. Our skill registration once
 * used an API that the installed opencode did not have, and the whole plugin -
 * tools included - went away with it. These tests pin the detection and the
 * "never fatal" behaviour.
 */

function captureLogger(): { log: PtyLogger; entries: string[] } {
  const entries: string[] = []
  return {
    entries,
    log: (level, message, details) =>
      entries.push(
        [level, message, details === undefined ? '' : JSON.stringify(details)].join(' ')
      ),
  }
}

describe('registerUsageSkill', () => {
  it('prefers draft.source() when the host exposes it', () => {
    const { log, entries } = captureLogger()
    const sources: unknown[] = []
    const draft: SkillDraft = { source: (source) => sources.push(source) }

    expect(registerUsageSkill(draft, log)).toBe('source')
    expect(sources).toHaveLength(1)
    expect(entries.join(' ')).toContain('via draft.source()')
  })

  it('falls back to draft.add() on hosts without source()', () => {
    const { log, entries } = captureLogger()
    const added: SkillEditorEntryV2[] = []
    const draft: SkillDraft = { add: (skill) => added.push(skill) }

    expect(registerUsageSkill(draft, log)).toBe('add')
    expect(added).toHaveLength(1)
    expect(added[0]?.id).toBe(PTY_USAGE_SKILL_ID)
    expect(added[0]?.name).toBe('pty-usage')
    expect(added[0]?.content.length).toBeGreaterThan(500)
    expect(entries.join(' ')).toContain('via draft.add()')
  })

  it('reports a host with neither API instead of throwing', () => {
    const { log, entries } = captureLogger()

    expect(registerUsageSkill({}, log)).toBe('none')
    expect(entries.join(' ')).toContain('neither source() nor add()')
  })
})

describe('Plugin.setup transform isolation', () => {
  it('stays alive when a transform throws', async () => {
    const ctx: PluginContextV2 = {
      options: {},
      skill: {
        transform: async () => {
          throw new Error('draft.source is not a function')
        },
      },
    }

    await expect(Plugin.setup(ctx)).resolves.toBeUndefined()
  })

  it('stays alive when the skill draft supports neither API', async () => {
    const transform = mock(async (callback: (draft: SkillDraft) => void) => {
      callback({})
    })
    const ctx: PluginContextV2 = { options: {}, skill: { transform } }

    await expect(Plugin.setup(ctx)).resolves.toBeUndefined()
    expect(transform).toHaveBeenCalled()
  })
})
