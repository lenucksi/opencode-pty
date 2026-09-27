import { describe, expect, it } from 'bun:test'

import { PTY_USAGE_SKILL } from '../src/v2/skill.ts'
import {
  CHARS_PER_TOKEN,
  DEFAULT_READ_LIMIT,
  DEFAULT_READ_MAX_TOKENS,
  MAX_READ_MAX_TOKENS,
} from '../src/shared/constants.ts'
import { ptyRead } from '../src/plugin/pty/tools/read.ts'
import { ptySpawn } from '../src/plugin/pty/tools/spawn.ts'
import { ptyResize } from '../src/plugin/pty/tools/resize.ts'
import { ptyScreen } from '../src/plugin/pty/tools/screen.ts'
import { FALLBACK_TERMINAL_COLS, FALLBACK_TERMINAL_ROWS } from '../src/plugin/constants.ts'
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

  it('documents the read budget, not the per-line clamp it replaced', async () => {
    const payload = await readDocsJson()
    const human = JSON.stringify(payload.sections)

    // Both audiences must name the real budget, or the model sizes its reads
    // against a number the server does not enforce.
    expect(PTY_USAGE_SKILL.content).toContain(String(DEFAULT_READ_MAX_TOKENS))
    expect(human).toContain(String(DEFAULT_READ_MAX_TOKENS))

    // And the ceiling, so a caller knows `maxTokens` is clamped rather than free.
    expect(PTY_USAGE_SKILL.content).toContain(String(MAX_READ_MAX_TOKENS))

    // The old clamp is gone. Its number must not survive anywhere as a promise
    // the reader will rely on.
    expect(PTY_USAGE_SKILL.content).not.toMatch(/truncated at 2000 characters/i)
    expect(human).not.toMatch(/truncated at 2000 characters/i)
  })

  it('documents the recovery path for a cut line in both audiences', () => {
    for (const text of [PTY_USAGE_SKILL.content, JSON.stringify(HUMAN_USAGE_DOCS)]) {
      expect(text).toContain('truncated')
      expect(text).toContain('nextSince')
    }
  })

  it('only documents pty_read parameters the tool actually accepts', () => {
    // The failure this guards: prose telling the model to pass `since` while the
    // schema has no such argument, which makes the documented recovery
    // impossible to perform.
    const documented = ['maxTokens', 'since', 'all'].filter((name) =>
      PTY_USAGE_SKILL.content.includes(name)
    )
    expect(documented.length).toBeGreaterThan(0)
    for (const name of documented) {
      expect(Object.keys(ptyRead.args ?? {})).toContain(name)
    }
  })

  it('states the char-per-token ratio it converts the budget with', () => {
    // The budget is only meaningful to a reader who can estimate its size.
    const approxChars = DEFAULT_READ_MAX_TOKENS * CHARS_PER_TOKEN
    expect(PTY_USAGE_SKILL.content).toContain(String(approxChars))
  })

  it('documents the terminal size the agent will actually get', () => {
    // The old default was a constant nobody could see or change, so a program
    // that wrapped badly was unexplainable from the agent's side.
    expect(PTY_USAGE_SKILL.content).toContain(`${FALLBACK_TERMINAL_COLS}x${FALLBACK_TERMINAL_ROWS}`)
    expect(PTY_USAGE_SKILL.content).toContain('pty_resize')
  })

  it('only documents geometry parameters pty_spawn really accepts', () => {
    const args = Object.keys(ptySpawn.args ?? {})
    expect(args).toContain('cols')
    expect(args).toContain('rows')
    // `pty_resize` is documented as the way to change a running session, so it
    // has to be a real tool with real arguments.
    expect(Object.keys(ptyResize.args ?? {})).toEqual(
      expect.arrayContaining(['id', 'cols', 'rows'])
    )
  })

  it('documents pty_screen and every parameter it accepts', () => {
    expect(PTY_USAGE_SKILL.content).toContain('pty_screen')
    const args = Object.keys(ptyScreen.args ?? {})
    for (const name of ['colors', 'width', 'height']) {
      if (PTY_USAGE_SKILL.content.includes(name)) expect(args).toContain(name)
    }
  })

  it('explains when to reach for pty_screen rather than pty_read', () => {
    // The two tools answer different questions; prose that does not say which is
    // which leaves the caller guessing and usually reaching for the wrong one.
    expect(PTY_USAGE_SKILL.content).toMatch(/layout/i)
    expect(PTY_USAGE_SKILL.content).toMatch(/pty_read.*cheaper/is)
  })

  it('tells the human where to find the running build', () => {
    // The one thing a bug report needs that nothing else in the UI provides.
    const human = JSON.stringify(HUMAN_USAGE_DOCS)
    expect(human).toMatch(/version/i)
    expect(human).toMatch(/commit/i)
  })

  it('documents the regex rejection path the reader can hit', () => {
    expect(PTY_USAGE_SKILL.content.toLowerCase()).toContain('backtracking')
  })

  it('keeps the documented read limit in sync with the constant', () => {
    expect(DEFAULT_READ_LIMIT).toBe(500)
    expect(PTY_USAGE_SKILL.content).toContain(String(DEFAULT_READ_LIMIT))
  })
})
