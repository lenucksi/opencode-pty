import { describe, expect, it } from 'bun:test'

import { PTY_USAGE_SKILL } from '../src/v2/skill.ts'
import { MAX_LINE_LENGTH, DEFAULT_READ_LIMIT } from '../src/shared/constants.ts'
import { resolveWebPort } from '../src/web/server/server.ts'
import { handleUsageDocs } from '../src/web/server/handlers/usage-docs.ts'
import { HUMAN_USAGE_DOCS, README_URL } from '../src/web/shared/usage-docs.ts'

/**
 * The docs dialog and the agent's instructions have to agree, and both have to
 * agree with the code. These tests fail when one side is edited without the
 * others: the skill used to claim a fixed default port that the server has
 * never used, and the 2000-character line truncation was invisible to the model
 * that hits it.
 */

async function readDocsJson() {
  const response = handleUsageDocs()
  return (await response.json()) as Awaited<
    ReturnType<typeof response.json> extends Promise<infer T> ? T : never
  >
}

describe('usage docs endpoint', () => {
  it('serves the LLM guide straight from the registered skill', async () => {
    const payload = await readDocsJson()

    expect(payload.llm.name).toBe(PTY_USAGE_SKILL.name)
    expect(payload.llm.content).toBe(PTY_USAGE_SKILL.content)
    expect(payload.llm.location).toBe(PTY_USAGE_SKILL.location)
    expect(payload.llm.content.length).toBeGreaterThan(500)
  })

  it('serves the human sections plus a readme link', async () => {
    const payload = await readDocsJson()

    expect(payload.readmeUrl).toBe(README_URL)
    expect(README_URL).toMatch(/^https:\/\/github\.com\//)
    expect(payload.sections).toEqual([...HUMAN_USAGE_DOCS])
    expect(payload.sections.length).toBeGreaterThan(3)
    for (const section of payload.sections) {
      expect(section.id.length).toBeGreaterThan(0)
      expect(section.title.length).toBeGreaterThan(0)
      expect(section.body?.length ?? section.list?.length ?? 0).toBeGreaterThan(0)
    }
  })

  it('uses unique section ids so tab panels stay addressable', () => {
    const ids = HUMAN_USAGE_DOCS.map((section) => section.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('docs stay true to the implementation', () => {
  it('does not claim a fixed default web UI port', async () => {
    const payload = await readDocsJson()

    // The server assigns an OS port when nothing is configured, so a hardcoded
    // port in the docs is wrong by construction.
    expect(resolveWebPort({})).toBe(0)
    expect(payload.llm.content).not.toMatch(/\b4200\b/)
    expect(JSON.stringify(payload)).not.toMatch(/\b4200\b/)
  })

  it('documents the configured port as an override, not a default', () => {
    expect(resolveWebPort({ port: 4200 })).toBe(4200)
    expect(PTY_USAGE_SKILL.content).toMatch(/ephemeral/i)
  })

  it('documents the real line truncation limit in both audiences', async () => {
    const payload = await readDocsJson()

    expect(MAX_LINE_LENGTH).toBe(2000)
    expect(PTY_USAGE_SKILL.content).toContain(String(MAX_LINE_LENGTH))
    expect(JSON.stringify(payload.sections)).toContain(String(MAX_LINE_LENGTH))
  })

  it('documents the regex rejection path the reader can hit', () => {
    expect(PTY_USAGE_SKILL.content.toLowerCase()).toContain('backtracking')
  })

  it('keeps the documented read limit in sync with the constant', () => {
    expect(DEFAULT_READ_LIMIT).toBe(500)
    expect(PTY_USAGE_SKILL.content).toContain(String(DEFAULT_READ_LIMIT))
  })
})
