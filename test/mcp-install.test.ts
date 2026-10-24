import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  edgesFor,
  installPlan,
  mergeOpencodeConfig,
  mcpEntry,
  opencodeConfigPath,
  PACKAGE_NAME,
  writeOpencodeEdge,
} from '../src/mcp/install.ts'

/**
 * The installer's two edges.
 *
 * One package is reached two ways - OpenCode loads it as a plugin from
 * `opencode.json`, every other harness starts `agentterm-mcp` as a stdio server - and
 * an installer that knows only one of them is half an installer. These cases pin the
 * plan, the merge, and the one file it is allowed to write.
 */

const temps: string[] = []

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempHome(): { home: string; xdgConfigHome: string } {
  const root = mkdtempSync(join(tmpdir(), 'agentterm-install-'))
  temps.push(root)
  return { home: join(root, 'home'), xdgConfigHome: join(root, 'config') }
}

describe('the plan', () => {
  it('carries both edges: the OpenCode plugin and the MCP server', () => {
    const plan = installPlan(tempHome())
    const harnesses = plan.map((edge) => edge.harness)

    expect(harnesses).toContain('opencode')
    expect(harnesses).toContain('generic')
    // The two that have their own mechanism get their own edge, rather than one
    // vague "other".
    expect(harnesses).toContain('claude')
    expect(harnesses).toContain('codex')
  })

  it('names the plugin entry the host reads and the package it comes from', () => {
    // One env for the plan and the expectation: two `tempHome()` calls are two
    // different directories, which is how this case first failed.
    const env = tempHome()
    const plan = installPlan(env)
    const opencode = plan.find((edge) => edge.harness === 'opencode')

    expect(opencode?.snippet).toContain(PACKAGE_NAME)
    expect(opencode?.snippet).toContain('"plugin"')
    // The file it writes is the global config, and it is the only edge with one.
    expect(opencode?.file).toBe(opencodeConfigPath(env))
    expect(plan.filter((edge) => edge.file !== null)).toHaveLength(1)
  })

  it('starts the MCP server with bunx, so nothing has to be installed globally', () => {
    const plan = installPlan(tempHome())
    const generic = plan.find((edge) => edge.harness === 'generic')

    expect(generic?.snippet).toContain('"mcpServers"')
    expect(generic?.snippet).toContain('"bunx"')
    expect(generic?.snippet).toContain(PACKAGE_NAME)
    expect(mcpEntry()).toEqual({ command: 'bunx', args: ['-p', PACKAGE_NAME, 'agentterm-mcp'] })
  })

  it('says why the edges it does not write are print-only', () => {
    const plan = installPlan(tempHome())

    for (const edge of plan.filter((candidate) => candidate.file === null)) {
      expect(edge.note ?? '').not.toBe('')
    }
    // Claude Code is a command, not a file: its own `mcp add` is the right mechanism.
    expect(plan.find((edge) => edge.harness === 'claude')?.snippet).toStartWith('claude mcp add')
    // Codex reads TOML, and this tool does not edit TOML.
    expect(plan.find((edge) => edge.harness === 'codex')?.snippet).toContain('[mcp_servers.')
  })

  it('filters by harness without inventing one', () => {
    const plan = installPlan(tempHome())

    expect(edgesFor(plan, 'all')).toHaveLength(plan.length)
    expect(edgesFor(plan, 'opencode').map((edge) => edge.harness)).toEqual(['opencode'])
    expect(edgesFor(plan, 'generic').map((edge) => edge.harness)).toEqual(['generic'])
  })
})

describe('merging an existing opencode.json', () => {
  it('keeps everything that was there', () => {
    const existing = JSON.stringify({
      model: 'x/y',
      plugin: ['other-plugin'],
      permission: { bash: { 'rm *': 'deny' } },
    })

    const merged = JSON.parse(mergeOpencodeConfig(existing)) as Record<string, unknown>

    expect(merged.model).toBe('x/y')
    expect(merged.permission).toEqual({ bash: { 'rm *': 'deny' } })
    expect(merged.plugin).toEqual(['other-plugin', { package: PACKAGE_NAME }])
  })

  it('does not add a second entry for this package', () => {
    const once = mergeOpencodeConfig(null)
    const twice = JSON.parse(mergeOpencodeConfig(once)) as { plugin: unknown[] }

    expect(twice.plugin).toHaveLength(1)
  })

  it('keeps the options an earlier install chose', () => {
    const existing = JSON.stringify({
      plugin: [{ package: PACKAGE_NAME, options: { port: 4300, daemon: true } }],
    })

    const merged = JSON.parse(mergeOpencodeConfig(existing)) as {
      plugin: { options?: Record<string, unknown> }[]
    }

    // A re-run must not reset the port someone picked.
    expect(merged.plugin[0]?.options).toEqual({ port: 4300, daemon: true })
  })

  it('refuses a config that is not an object rather than replacing it', () => {
    expect(() => mergeOpencodeConfig('[]')).toThrow('must contain a JSON object')
    expect(() => mergeOpencodeConfig('"a string"')).toThrow('must contain a JSON object')
  })

  it('starts from an empty object when the file does not exist', () => {
    const merged = JSON.parse(mergeOpencodeConfig(null)) as { plugin: unknown[] }
    expect(merged.plugin).toEqual([{ package: PACKAGE_NAME }])
  })
})

describe('writing the OpenCode edge', () => {
  it('creates the file, then backs it up before the next write', () => {
    const env = tempHome()

    const first = writeOpencodeEdge(env)
    expect(first.backup).toBeNull()
    expect(readFileSync(first.path, 'utf8')).toContain(PACKAGE_NAME)

    // A second write with the entry already present is a no-op: no backup of an
    // unchanged file, no churn.
    const second = writeOpencodeEdge(env)
    expect(second.backup).toBeNull()

    // A change to the file means the next write backs the old one up first.
    writeFileSync(first.path, `${JSON.stringify({ plugin: ['other'] }, null, 2)}\n`)
    const third = writeOpencodeEdge(env)
    expect(third.backup).toBe(`${first.path}.bak`)
    expect(readFileSync(`${first.path}.bak`, 'utf8')).toContain('other')
    expect(readFileSync(first.path, 'utf8')).toContain(PACKAGE_NAME)
  })
})
