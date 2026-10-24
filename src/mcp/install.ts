import { existsSync, readFileSync, copyFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { mkdirSync } from 'node:fs'

/**
 * The two edges this package is installed through.
 *
 * agentterm is reachable from a harness in two ways, and an "install" that only
 * knows one of them is half an installer: **OpenCode** loads it as a plugin, from
 * an entry in `opencode.json`, and everything else (Claude Code, Codex, any MCP
 * client) starts `agentterm-mcp` as a stdio server from its `mcpServers` block.
 * The same package serves both, so the plan names both and lets a reader pick.
 *
 * Print by default, write only with `--write`, and only into a JSON file we can
 * merge without guessing: a file this tool would have to overwrite, or one in
 * another format, is printed with the reason it was not written. Auto-editing a
 * harness's permission settings - which a comparable tool does - is not something
 * an installer should decide for a user.
 */

export const PACKAGE_NAME = '@lenucksi/agentterm'
export const MCP_BIN = 'agentterm-mcp'

export type Harness = 'opencode' | 'claude' | 'codex' | 'generic'

export interface InstallEdge {
  readonly harness: Harness
  /** One line the reader sees first. */
  readonly title: string
  /** The file the entry belongs in, or null when the harness has no file we edit. */
  readonly file: string | null
  /** Exactly what to add, as the harness wants to read it. */
  readonly snippet: string
  /** Why it is print-only, when there is no file. */
  readonly note?: string
}

export interface InstallEnv {
  readonly home: string
  /** `$XDG_CONFIG_HOME`, or undefined - opencode falls back to `~/.config`. */
  readonly xdgConfigHome?: string
}

/** Where OpenCode reads its global configuration. */
export function opencodeConfigPath(env: InstallEnv): string {
  const base = env.xdgConfigHome ?? join(env.home, '.config')
  return join(base, 'opencode', 'opencode.json')
}

/** The plugin entry OpenCode loads. */
export function opencodeEntry(): Record<string, unknown> {
  return { package: PACKAGE_NAME }
}

/** The `mcpServers` entry a stdio MCP client starts. */
export function mcpEntry(): Record<string, unknown> {
  return { command: 'bunx', args: ['-p', PACKAGE_NAME, MCP_BIN] }
}

/** The four edges, in the order a reader should consider them. */
export function installPlan(env: InstallEnv): readonly InstallEdge[] {
  const opencodeFile = opencodeConfigPath(env)
  return [
    {
      harness: 'opencode',
      title: 'OpenCode — the plugin, which is also the TUI panel',
      file: opencodeFile,
      snippet: JSON.stringify({ plugin: [opencodeEntry()] }, null, 2),
      note: 'merges into the existing "plugin" array; nothing else in the file is touched',
    },
    {
      harness: 'generic',
      title: 'Any MCP client — a stdio server named "agentterm"',
      file: null,
      snippet: JSON.stringify({ mcpServers: { agentterm: mcpEntry() } }, null, 2),
      note: "for .mcp.json (project) or the client's own config; add it yourself",
    },
    {
      harness: 'claude',
      title: 'Claude Code — one command, no file editing',
      file: null,
      snippet: `claude mcp add --scope user agentterm -- bunx -p ${PACKAGE_NAME} ${MCP_BIN}`,
      note: 'Claude Code owns its own config and its own scopes; this is its mechanism',
    },
    {
      harness: 'codex',
      title: 'Codex — a TOML block, because its config is TOML',
      file: null,
      snippet: [
        '[mcp_servers.agentterm]',
        'command = "bunx"',
        `args = ["-p", "${PACKAGE_NAME}", "${MCP_BIN}"]`,
      ].join('\n'),
      note: 'appended to ~/.codex/config.toml by hand; this tool does not edit TOML',
    },
  ]
}

/** The edges a harness selector asks for, in plan order. */
export function edgesFor(plan: readonly InstallEdge[], harness: Harness | 'all'): InstallEdge[] {
  if (harness === 'all') return [...plan]
  // `--harness mcp` is not a harness; it is the two that take a snippet. Kept out of
  // the type so a typo cannot silently mean "all".
  return plan.filter((edge) => edge.harness === harness)
}

/**
 * The OpenCode config with our plugin entry added, as formatted JSON.
 *
 * Merging rather than writing a fresh file: the user's config holds their model,
 * their other plugins and their permissions, and an installer that replaces it is a
 * data-loss bug with a friendly name. Imported options of an existing entry for this
 * package are preserved - a re-run must not throw away the port someone chose.
 */
export function mergeOpencodeConfig(existing: string | null): string {
  const parsed: unknown = existing === null || existing.trim() === '' ? {} : JSON.parse(existing)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('opencode.json must contain a JSON object')
  }
  const config = parsed as Record<string, unknown>
  const current = Array.isArray(config.plugin) ? config.plugin : []
  const kept = current.filter((entry) => {
    if (typeof entry === 'string') return entry !== PACKAGE_NAME
    if (typeof entry !== 'object' || entry === null) return true
    return (entry as { package?: unknown }).package !== PACKAGE_NAME
  })
  const previous = current.find(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      (entry as { package?: unknown }).package === PACKAGE_NAME
  ) as { options?: Record<string, unknown> } | undefined
  const restored =
    previous?.options === undefined
      ? opencodeEntry()
      : { ...opencodeEntry(), options: previous.options }
  config.plugin = [...kept, restored]
  return `${JSON.stringify(config, null, 2)}\n`
}

/** What `--write` actually did, for the line the reader gets afterwards. */
export interface WriteResult {
  readonly path: string
  readonly backup: string | null
}

/**
 * Write the OpenCode edge, with a backup of whatever was there.
 *
 * The backup name is fixed (`<file>.bak`) rather than timestamped: a second run
 * overwrites the first backup, which is the one that still matters, and a directory
 * full of backups is its own kind of mess.
 */
export function writeOpencodeEdge(env: InstallEnv): WriteResult {
  const path = opencodeConfigPath(env)
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : null
  const merged = mergeOpencodeConfig(existing)
  if (existing !== null && existing === merged) return { path, backup: null }
  if (existing !== null) copyFileSync(path, `${path}.bak`)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, merged, { mode: 0o600 })
  return { path, backup: existing === null ? null : `${path}.bak` }
}
