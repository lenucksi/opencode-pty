import type { Plugin } from '@opencode/plugin'
import type { RetentionPolicy } from '../plugin/pty/session-store.ts'

export interface OpencodePtyOptions {
  /**
   * Fixed port for the PTY Web UI observer server.
   * If not set, defaults to an available ephemeral port or PTY_WEB_PORT env var.
   */
  port?: number

  /**
   * Hostname to bind the PTY Web UI observer server to.
   * Defaults to '::1' (or PTY_WEB_HOSTNAME env var).
   */
  hostname?: string

  /**
   * Automatically start the PTY Web UI observer server upon plugin initialization.
   * Default is false (started on-demand when slash command is executed).
   */
  autostart?: boolean

  /**
   * Delegate PTY sessions to a persistent daemon process so they survive
   * opencode server restarts. Default is false (in-process).
   */
  daemon?: boolean

  /** Where the daemon keeps its archive. Defaults to the plugin's sessions root. */
  stateDir?: string

  /**
   * How long archived sessions are kept, and how many.
   *
   * `maxSessions` is a count cap, `maxAgeDays` an age cap, and `maxBytesPerSession` a
   * per-session log cap beyond which the log rotates once. Both caps are enforced on the
   * shared on-disk archive, so they belong here rather than in a viewer's preferences: a
   * per-browser cap could not bind an index every client reads.
   *
   * Changing a cap takes effect at once - `updateRetention` re-prunes - and lowering one
   * removes sessions immediately. They are renamed to `.trash` rather than deleted and stay
   * restorable until the next start, the same undo window a normal removal gets.
   *
   * Anything omitted keeps its default: `{ maxSessions: 200, maxAgeDays: 14,
   * maxBytesPerSession: 5 * 1024 * 1024 }`.
   */
  retention?: Partial<RetentionPolicy>
}

/**
 * Command definition accepted by opencode v2's CommandEditor.
 *
 * NOTE: opencode v2's `command.transform` draft exposes `add(definition)`
 * (see `CommandEditor` in @opencode-ai/plugin). There is no `update`/`list`/`get`.
 */
export interface CommandDefinition {
  name: string
  description?: string
  execute: (input: unknown) => Promise<void> | void
}

export interface CommandDraft {
  add?(command: CommandDefinition): void
  list?(): readonly unknown[]
  get?(name: string): unknown
  remove?(name: string): void
  [key: string]: unknown
}

/**
 * Tool definition accepted by opencode v2's ToolEditor.
 *
 * Mirrors `Tool.Info` from @opencode-ai/plugin's promise API:
 *   { name, input, description, execute(input, context) }
 */
export interface ToolInfoV2 {
  name: string
  description: string
  input: unknown
  execute: (input: unknown, context: unknown) => Promise<unknown>
}

export interface ToolDraft {
  add?(tool: ToolInfoV2): void
  [key: string]: unknown
}

/**
 * Skill definition accepted by opencode v2's skill editor.
 *
 * Mirrors `SkillV2Info` from @opencode-ai/sdk/v2/types. A skill is loaded on
 * demand, so detailed guidance can live here instead of in the always-on tool
 * descriptions.
 */
export interface SkillInfoV2 {
  name: string
  description?: string
  slash?: boolean
  location: string
  content: string
}

export type SkillSourceV2 =
  | { type: 'directory'; path: string }
  | { type: 'url'; url: string }
  | { type: 'embedded'; skill: SkillInfoV2 }

/**
 * A fully described skill, as the 2.0.x skill editor accepts it
 * (`SkillEditor.add(skill: Skill.Info)`).
 */
export interface SkillEditorEntryV2 {
  id: string
  name: string
  description?: string
  /** Absolute path; hosts use it as the skill's identity/location. */
  path: string
  content: string
}

/**
 * The skill draft handed to `ctx.skill.transform`.
 *
 * Hosts differ: `source()` exists on newer opencode builds, while the 2.0.x
 * editor exposes `add()`. Both are optional here and detected at runtime - a
 * draft that has neither must not be a fatal error, or the host disables the
 * whole plugin (which is exactly what happened once).
 */
export interface SkillDraft {
  source?(source: SkillSourceV2): void
  add?(skill: SkillEditorEntryV2): void
  list?(): readonly unknown[]
}

export interface PluginContextV2 {
  readonly options?: OpencodePtyOptions & Record<string, unknown>
  /**
   * Where the host thinks the project is.
   *
   * Needed to publish the server's origin under a key a TUI can look up: the
   * address alone is not enough, because a machine can have several servers and
   * a reader has to know which one belongs to the session it is rendering.
   * Typed from `@opencode/plugin` so the path is the real one. Optional because
   * a host predating the field still runs, and then the origin is published
   * without a project key - findable by probing, not by lookup.
   */
  readonly location?: {
    readonly directory: string
  }
  /**
   * Host application info (name/version/channel). Used in restart notices so a
   * reader knows which opencode build the sessions were lost to.
   */
  readonly app?: {
    readonly name?: string
    readonly version?: string
    readonly channel?: string
  }
  readonly command?: {
    transform(
      callback: (commands: CommandDraft) => Promise<void> | void
    ): Promise<unknown> | undefined
    reload?(): Promise<void> | void
  }
  readonly tool?: {
    transform(callback: (tools: ToolDraft) => Promise<void> | void): Promise<unknown> | undefined
    reload?(): Promise<void> | void
  }
  readonly skill?: {
    transform(callback: (skill: SkillDraft) => Promise<void> | void): Promise<unknown> | undefined
    reload?(): Promise<void> | void
  }
  /**
   * opencode v2's plugin contexts are server clients: the `session` domain is
   * how a plugin reads sessions and wakes them with user prompts. Typed from
   * `@opencode/plugin` (the V2 SDK) so `ctx.session?.prompt` is checked
   * against the real `SessionPromptInput`. Optional because hosts pre-2.0.x
   * may not expose it; the setup guards at runtime.
   */
  readonly session?: {
    readonly prompt: Plugin.Context['session']['prompt']
    /** Resolves the session title, which the sidebar uses as the group label. */
    readonly get?: Plugin.Context['session']['get']
  }
  /**
   * The host's RPC domain, when the build has one.
   *
   * This is how the TUI half asks where this server listens instead of deriving it: one
   * `opencode serve --service` hosts the plugin for every project, so the origin record is filed
   * under a directory no panel can compute from its own session. Typed from `@opencode/plugin`
   * so the shape is the real one; optional, because a host without RPC still loads and then the
   * panel falls back to the record.
   */
  readonly rpc?: Plugin.Context['rpc']
}

export interface PluginV2 {
  readonly id: string
  readonly setup: (context: PluginContextV2) => Promise<void> | void
}

export function define(plugin: PluginV2): PluginV2 {
  return plugin
}
