/**
 * A throwaway opencode installation per harness run.
 *
 * Everything the run can touch lives under one temp directory: the config that
 * declares the plugin, the database, the logs, the project the session runs in,
 * and the plugin's own archived-session state. Nothing outside it is written,
 * and removing the directory is the whole cleanup.
 *
 * The plugin is not installed on the host, so it has to be made loadable. Two
 * findings from opencode 2.0.18 shape the approach:
 *
 * 1. A `plugin` entry that is not `file://<directory>` is rejected - a file path
 *    logs "configured plugin path must be a directory". A directory resolves
 *    through its own entrypoint, and the repo root's entrypoint is the **V1**
 *    plugin, which 2.x refuses ("Plugin must export a default definition with an
 *    id and an effect or setup function"). So the harness writes a one-line shim
 *    package that re-exports the built V2 default, and points the config at the
 *    shim.
 * 2. Provider credentials live in the `credential` table of the opencode
 *    database, not in `auth.json`. A fresh database therefore has no
 *    `opencode-go` catalogue at all and every run fails with
 *    "Model unavailable". The harness bootstraps a database (one deliberately
 *    unresolvable model, no tokens spent) and copies that table across.
 */

import { Database } from 'bun:sqlite'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export const HARNESS_AGENT = 'pty-harness'
export const OPENCODE_BINARY = process.env.OPENCODE_BINARY ?? 'opencode'
/** Overrides where provider credentials are copied from. */
export const AUTH_DB_ENV = 'PTY_LLM_HARNESS_AUTH_DB'

/** A model id that cannot resolve, used to make the host create its database. */
const BOOTSTRAP_MODEL = 'opencode-pty-harness/bootstrap-does-not-exist'

export interface WorkspaceOptions {
  /** Where the plugin source lives. Defaults to the repository root. */
  repoRoot?: string
  /** Extra environment for the run. Wins over the harness defaults. */
  env?: Record<string, string>
  /** Tools the agent must not have. */
  disabledTools?: readonly string[]
  /** Keep the directory after the run instead of deleting it. */
  keep?: boolean
  /** Prefix for the temp directory name. */
  label?: string
}

export interface Workspace {
  root: string
  projectDir: string
  configPath: string
  dataHome: string
  stateHome: string
  ptyStateDir: string
  pluginLogPath: string
  hostLogPath: string
  env: Record<string, string>
  warnings: string[]
  cleanup: () => void
}

/** Walk up from this file to the package root that owns the plugin. */
export function findRepoRoot(from: string = import.meta.dir): string {
  let current = resolve(from)
  for (;;) {
    const manifest = join(current, 'package.json')
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }
        if (parsed.name === 'opencode-pty') return current
      } catch {
        // A malformed manifest is not ours; keep walking.
      }
    }
    const parent = dirname(current)
    if (parent === current) {
      throw new Error(`could not find the opencode-pty package root above ${from}`)
    }
    current = parent
  }
}

/** The built V2 entrypoint, which is the only shape opencode 2.x accepts. */
export function pluginEntryPoint(repoRoot: string): string {
  return join(repoRoot, 'dist', 'src', 'v2', 'index.js')
}

export function assertPluginBuilt(repoRoot: string): void {
  if (!existsSync(pluginEntryPoint(repoRoot))) {
    throw new Error(
      `the plugin is not built: ${pluginEntryPoint(repoRoot)} is missing.\n` +
        'Run `bun run build:prod` first. The harness loads the built artifact, not the source, ' +
        'so a stale or missing dist would otherwise test nothing.'
    )
  }
}

/** The opencode database that holds the host's provider credentials. */
export function sourceAuthDatabase(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[AUTH_DB_ENV]
  if (override !== undefined && override !== '') return override
  const dataHome = env.XDG_DATA_HOME ?? join(env.HOME ?? homedir(), '.local', 'share')
  return join(dataHome, 'opencode', 'opencode.db')
}

export interface CredentialCopy {
  copied: number
  /** Set when the table could not be read, with the reason. */
  problem: string | null
}

/**
 * Copy the host's provider credentials into a fresh database.
 *
 * Read-only on the source. Returns the row count so a run can report zero
 * copied credentials rather than failing later with an opaque model error.
 */
export function copyCredentials(source: string, target: string): CredentialCopy {
  if (!existsSync(source)) {
    return { copied: 0, problem: `no opencode database at ${source}` }
  }
  const columns =
    'id, integration_id, label, value, connector_id, method_id, active, time_created, time_updated'
  let read: string[][] = []
  try {
    const from = new Database(source, { readonly: true })
    try {
      const hasTable = from
        .query<{ name: string }, []>(
          "select name from sqlite_master where type = 'table' and name = 'credential'"
        )
        .all()
      if (hasTable.length === 0)
        return { copied: 0, problem: 'the source database has no credential table' }
      read = from
        .query<Record<string, string>, []>(`select ${columns} from credential`)
        .all()
        .map((row) => columns.split(', ').map((column) => String(row[column])))
    } finally {
      from.close()
    }
  } catch (error) {
    return { copied: 0, problem: error instanceof Error ? error.message : String(error) }
  }

  try {
    const into = new Database(target)
    try {
      const insert = into.prepare(
        `insert or replace into credential (${columns}) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      const transaction = into.transaction((rows: string[][]) => {
        for (const row of rows) insert.run(...row)
      })
      transaction(read)
    } finally {
      into.close()
    }
  } catch (error) {
    // Most often: the host has not run its migrations yet, so there is no
    // table to insert into. Say that rather than failing later with
    // "Model unavailable", which points at the wrong thing entirely.
    return {
      copied: 0,
      problem: `could not write ${target}: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  return { copied: read.length, problem: null }
}

export interface HarnessConfig {
  plugin: readonly string[]
  small_model: string
  agent: Record<string, unknown>
  permission: Record<string, unknown>
}

/** The config the isolated host runs with. */
export function buildHarnessConfig(options: {
  pluginDir: string
  model: string
  disabledTools: readonly string[]
}): HarnessConfig {
  return {
    plugin: [`file://${options.pluginDir}`],
    small_model: options.model,
    agent: {
      [HARNESS_AGENT]: {
        description: 'Isolated agent used by the opencode-pty LLM harness.',
        mode: 'primary',
        tools: Object.fromEntries(options.disabledTools.map((name) => [name, false])),
      },
    },
    // No network beyond the model endpoint: webfetch/websearch would make a run
    // non-reproducible and cost money for nothing.
    permission: { webfetch: 'deny', 'websearch*': 'deny' },
  }
}

/** A process environment with every opencode/XDG variable replaced. */
export function buildRunEnv(options: {
  workspace: Workspace
  base?: NodeJS.ProcessEnv
}): Record<string, string> {
  const base = options.base ?? process.env
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    // A harness that inherits OPENCODE_CONFIG or XDG_DATA_HOME is not isolated.
    if (key.startsWith('OPENCODE_') || key.startsWith('XDG_')) continue
    if (value !== undefined) env[key] = value
  }
  const workspace = options.workspace
  env.XDG_DATA_HOME = workspace.dataHome
  env.XDG_CONFIG_HOME = join(workspace.root, 'config')
  env.XDG_STATE_HOME = workspace.stateHome
  env.XDG_CACHE_HOME = join(workspace.root, 'cache')
  env.XDG_RUNTIME_DIR = join(workspace.root, 'runtime')
  env.OPENCODE_CONFIG_DIR = join(workspace.root, 'config', 'opencode')
  env.OPENCODE_PTY_STATE_DIR = workspace.ptyStateDir
  env.OPENCODE_DISABLE_AUTOUPDATE = '1'
  env.OPENCODE_DISABLE_FILEWATCHER = '1'
  // Project-level config is the leak that matters. opencode resolves the project
  // by walking up from the working directory, and that walk can land on a
  // checkout of this repository, whose own .opencode/opencode.json declares
  // `"plugin": ["../index.ts"]` - a file, which 2.x rejects. The global config
  // the harness writes is not affected by this switch.
  env.OPENCODE_DISABLE_PROJECT_CONFIG = '1'
  env.NO_COLOR = '1'
  // The host resolves the session's directory from PWD, not from getcwd(). A
  // child spawned with a different `cwd` still inherits the parent's PWD, so
  // without this the model runs in whatever directory the harness was launched
  // from - a checkout of this repository - and its sessions are created there.
  env.PWD = workspace.projectDir
  return env
}

/**
 * A package directory whose entrypoint re-exports the built V2 default.
 *
 * opencode insists on a directory and reads that directory's own entrypoint, so
 * a shim is the only way to point a run at `dist/src/v2/index.js` while the
 * repository root keeps the V1 entrypoint that 2.x refuses.
 */
export function writePluginShim(directory: string, repoRoot: string): void {
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(directory, 'package.json'),
    `${JSON.stringify(
      { name: 'opencode-pty-harness-shim', type: 'module', main: 'index.ts', private: true },
      null,
      2
    )}\n`
  )
  writeFileSync(
    join(directory, 'index.ts'),
    `export { default } from ${JSON.stringify(pluginEntryPoint(repoRoot))}\n`
  )
}

/**
 * Create a throwaway host: config, database, project directory and plugin shim.
 *
 * The database bootstrap is a real `opencode run` that fails at model
 * resolution, which is the cheapest way to make the host run its schema
 * migrations. It spends no tokens and normally returns in about two seconds.
 */
export function createWorkspace(options: WorkspaceOptions = {}): Workspace {
  const repoRoot = options.repoRoot ?? findRepoRoot()
  assertPluginBuilt(repoRoot)

  const label =
    options.label === undefined ? 'opencode-pty-llm-' : `opencode-pty-llm-${options.label}-`
  const root = mkdtempSync(join(tmpdir(), label))
  const warnings: string[] = []

  const projectDir = join(root, 'project')
  const dataHome = join(root, 'data')
  const stateHome = join(root, 'state')
  const configHome = join(root, 'config')
  for (const directory of [
    projectDir,
    join(dataHome, 'opencode'),
    stateHome,
    join(configHome, 'opencode'),
    join(root, 'cache'),
    join(root, 'runtime'),
  ]) {
    mkdirSync(directory, { recursive: true })
  }

  const pluginDir = join(root, 'plugin')
  writePluginShim(pluginDir, repoRoot)

  const authJson = join(sourceAuthDatabase().replace(/opencode\.db$/, ''), 'auth.json')
  if (existsSync(authJson)) {
    try {
      symlinkSync(authJson, join(dataHome, 'auth.json'))
    } catch (error) {
      warnings.push(`could not link auth.json: ${describe(error)}`)
    }
  }

  const workspace: Workspace = {
    root,
    projectDir,
    configPath: join(configHome, 'opencode', 'opencode.json'),
    dataHome,
    stateHome,
    ptyStateDir: join(root, 'pty-state'),
    pluginLogPath: join(stateHome, 'opencode', 'opencode-pty.log'),
    hostLogPath: join(dataHome, 'opencode', 'log', 'opencode.log'),
    env: {},
    warnings,
    cleanup: () => {
      if (options.keep === true) return
      rmSync(root, { recursive: true, force: true })
    },
  }
  return workspace
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Give the isolated host a database with the host's provider credentials.
 *
 * Returns the number of credentials copied. Zero is not fatal - the free
 * `opencode/*` models need none - so the caller decides. `binary` and `source`
 * are overridable so the path can be exercised without a real host binary or a
 * real credential store.
 */
export function bootstrapCredentials(
  workspace: Workspace,
  env: Record<string, string>,
  binary: string = OPENCODE_BINARY,
  source: string = sourceAuthDatabase()
): number {
  const bootstrap = spawnSync(
    binary,
    ['run', '--format=json', '--standalone', '--auto', '--model', BOOTSTRAP_MODEL, 'unused'],
    {
      cwd: workspace.projectDir,
      env,
      encoding: 'utf8',
      timeout: 120_000,
    }
  )
  if (bootstrap.error) {
    workspace.warnings.push(`database bootstrap failed: ${describe(bootstrap.error)}`)
  }
  const result = copyCredentials(source, join(workspace.dataHome, 'opencode', 'opencode.db'))
  if (result.problem !== null) workspace.warnings.push(`credentials not copied: ${result.problem}`)
  return result.copied
}

/** Write the harness config once the model and tool allowlist are known. */
export function writeHarnessConfig(workspace: Workspace, config: HarnessConfig): void {
  writeFileSync(workspace.configPath, `${JSON.stringify(config, null, 2)}\n`)
}

/** Did the plugin actually register itself? Read from its own log, not the model's report. */
export function pluginDidLoad(workspace: Workspace): boolean {
  if (!existsSync(workspace.pluginLogPath)) return false
  const log = readFileSync(workspace.pluginLogPath, 'utf8')
  return PLUGIN_LOAD_MARKERS.some((marker) => log.includes(marker))
}

/**
 * Lines the plugin writes while setting up. Any one of them means the host
 * accepted the plugin and ran its V2 `setup`.
 */
const PLUGIN_LOAD_MARKERS = [
  'v2 exit notifications enabled',
  'host adapter installed',
  'pty-usage skill registered',
] as const

/**
 * Everything the PTY sessions in a workspace actually printed.
 *
 * Read from the plugin's own archive, not from the transcript, so a case can
 * tell "a PTY produced this" from "a model read the fixture's source and said
 * it". The archive holds the raw output stream; the metadata holds commands and
 * descriptions, and neither ever contains the token a case seeds.
 */
export function readArchivedOutput(ptyStateDir: string): string {
  // OPENCODE_PTY_STATE_DIR replaces the whole sessions root, so the
  // per-session directories sit directly under it. Without the override they
  // would be under a sessions directory, and a reader that only looked for
  // one of the two would silently find nothing - and then every case that
  // seeds a token would fail on 'no pty session ever printed it'.
  const roots = [ptyStateDir, join(ptyStateDir, 'sessions')].filter((dir) => existsSync(dir))
  const chunks: string[] = []
  for (const root of roots) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const directory = join(root, entry.name)
      for (const name of readdirSync(directory)) {
        // index.json and meta.json describe the session; output.log is what it
        // printed, and only that can contain a case's token.
        if (!name.startsWith('output.log')) continue
        try {
          chunks.push(readFileSync(join(directory, name), 'utf8'))
        } catch {
          // A session still being appended to is not a reason to fail.
        }
      }
    }
  }
  return chunks.join('\n')
}

/** Host-side plugin loading problems, if the host reported any. */
export function pluginLoadWarnings(workspace: Workspace): string[] {
  if (!existsSync(workspace.hostLogPath)) return []
  return readFileSync(workspace.hostLogPath, 'utf8')
    .split('\n')
    .filter((line) =>
      /failed to load plugin|must be a directory|PluginModule|must export a default/i.test(line)
    )
    .map((line) => line.slice(0, 300))
}
