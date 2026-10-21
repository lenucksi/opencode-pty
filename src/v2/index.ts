import { installHostAdapter } from '../adapters/index.ts'
import { createV2Adapter } from '../adapters/v2/index.ts'
import { getPtyManager } from '../plugin/pty/manager.ts'
import { setParentSessionTitleResolver } from '../plugin/pty/parent-session-title.ts'
import { logPtyEvent } from '../plugin/pty/plugin-log.ts'
import { getActiveServer, getOrCreateServer, registerV2Commands } from './commands.ts'
import { V2SessionNotifier } from './notifier.ts'
import { announceRestart } from './restart-announce.ts'
import { PtyServerRpc, serverOrigin } from './rpc.ts'
import { registerUsageSkill } from './skill.ts'
import { registerV2Tools } from './tools.ts'
import { define, type OpencodePtyOptions, type PluginContextV2, type PluginV2 } from './types.ts'

export * from './commands.ts'
export * from './notifier.ts'
export * from './skill.ts'
export * from './tools.ts'
export * from './types.ts'

/**
 * Run one optional registration step in isolation.
 *
 * The host disables a plugin whose transform throws, so a feature that a given
 * opencode build does not support has to degrade to a log line instead of
 * taking tools, commands and notifications down with it.
 */
async function runRegistration(
  feature: string,
  run: () => Promise<unknown> | undefined
): Promise<void> {
  try {
    await run()
  } catch (error) {
    logPtyEvent('error', `${feature} registration failed; continuing without it`, error)
  }
}

/**
 * OpenCode V2 Plugin definition for opencode-pty.
 * Conforms to the V2 Plugin.define({ id, setup }) contract.
 */
export const Plugin: PluginV2 = define({
  id: 'opencode-pty',
  setup: async (ctx: PluginContextV2) => {
    const sessionDomain = ctx.session
    const getSession = sessionDomain?.get
    if (typeof getSession === 'function') {
      setParentSessionTitleResolver({
        getTitle: async (sessionID) => (await getSession({ sessionID })).title,
      })
    } else {
      setParentSessionTitleResolver(null)
    }

    // opencode v2 plugin contexts are server clients: `ctx.session.prompt`
    // wakes a session with a user prompt, preserving the session's current
    // model by construction. Pre-2.0 hosts without the session domain still
    // load the plugin, but exit notifications are disabled with a visible
    // warning instead of silently never arriving.
    const notifier =
      typeof ctx.session?.prompt === 'function' ? new V2SessionNotifier(ctx.session) : undefined
    if (!notifier) {
      logPtyEvent('warn', 'v2 exit notifications disabled: ctx.session.prompt is unavailable', {
        hasSession: ctx.session !== undefined,
        promptType: typeof ctx.session?.prompt,
      })
      console.warn(
        '[opencode-pty] host does not expose ctx.session.prompt — exit notifications disabled'
      )
    } else {
      logPtyEvent('info', 'v2 exit notifications enabled')
    }

    const adapter = createV2Adapter({ notifier })
    installHostAdapter(adapter)

    // The TUI half asks this for the address instead of deriving it from the origin record: one
    // `opencode serve --service` hosts the plugin for every project the user opens, so the record
    // is filed under the directory THAT process was started in - which no panel can compute from
    // its own session. Registered even without `autostart`, because "not running" is an answer the
    // panel needs. `runRegistration` keeps a build without RPC loading everything else.
    await runRegistration('rpc', () =>
      ctx.rpc?.register(PtyServerRpc, {
        origin: async (_input, context) => {
          const url = serverOrigin(getActiveServer())
          if (url === null) return context.error('not_running', 'No PTY server is running yet', {})
          return { url }
        },
      })
    )

    // Each registration step is optional and isolated: a host that does not
    // implement one of them must not lose the tools (a single failing
    // transform used to make the host disable the entire plugin).
    const toolDomain = ctx.tool
    if (toolDomain && typeof toolDomain.transform === 'function') {
      await runRegistration('tool', () =>
        toolDomain.transform((draft) => {
          registerV2Tools(draft)
        })
      )
    }

    const commandDomain = ctx.command
    if (commandDomain && typeof commandDomain.transform === 'function') {
      await runRegistration('command', () =>
        commandDomain.transform((draft) => {
          registerV2Commands(draft, ctx.options as OpencodePtyOptions | undefined)
        })
      )
    }

    // Ship the detailed pty usage guide as an on-demand skill, so the
    // always-on tool descriptions can stay terse without losing guidance.
    const skillDomain = ctx.skill
    if (skillDomain && typeof skillDomain.transform === 'function') {
      await runRegistration('skill', () =>
        skillDomain.transform((draft) => {
          registerUsageSkill(draft)
        })
      )
    }

    // Daemon mode: optionally delegate to a persistent daemon process so PTY
    // sessions survive opencode server restarts. Opt-in via options.daemon or
    // the PTY_DAEMON env var. Falls back to in-process on any failure.
    const useDaemon = ctx.options?.daemon === true || process.env.PTY_DAEMON === '1'
    if (useDaemon) {
      try {
        const { connectToDaemon } = await import('../plugin/pty/manager.ts')
        await connectToDaemon({
          stateDir: ctx.options?.stateDir,
        })
        logPtyEvent('info', 'connected to pty daemon')
      } catch (error) {
        logPtyEvent('warn', 'daemon unavailable, using in-process manager', error)
      }
    }

    // Sessions archived by a previous run come back as read-only history, and
    // anything that was still running is marked as lost instead of silently
    // disappearing from listings.
    const restored = await getPtyManager().loadPersistedSessions()
    if (restored.length > 0) {
      logPtyEvent('info', `restored ${restored.length} archived session(s)`, {
        ids: restored.map((session) => session.id),
      })
    }

    // Retention configured through options, applied before anything is announced: the
    // restart message is built from `getRetention()`, so setting the policy after it would
    // advertise a limit the store is not yet applying. The re-prune inside `updateRetention`
    // is what makes a lowered cap take effect at once - the store's own `prune()` runs only
    // in its constructor, which is long before these options exist.
    const prunedRetention = await (await getPtyManager().getSessionStore()).updateRetention(
      ctx.options?.retention ?? {}
    )
    if (prunedRetention.length > 0) {
      logPtyEvent('info', `retention removed ${prunedRetention.length} archived session(s)`, {
        ids: prunedRetention,
      })
    }

    if (ctx.options?.autostart) {
      try {
        const server = await getOrCreateServer({
          port: ctx.options.port,
          hostname: ctx.options.hostname,
          // Published so a TUI can find this server by project. Without it
          // writeOrigin writes no record at all: an unkeyed one cannot be
          // attributed to an instance, and /api/server reports no project, so
          // even a probed candidate could not be told apart from another
          // instance's. A host that supplies no location therefore gets no
          // origin, rather than one that looks findable and is not.
          directory: ctx.location?.directory,
        })

        // Sessions that the previous run left behind are announced once per
        // boot, with the address a human can look at.
        await announceRestart({
          store: await getPtyManager().getSessionStore(),
          ...(notifier ? { notifier } : {}),
          restored,
          webUrl: `${server.server.url.origin}/`,
          ...(ctx.app?.version ? { hostVersion: ctx.app.version } : {}),
        })
      } catch (error) {
        // Never let web-server startup failure crash plugin setup: the PTY
        // tools stay fully functional in-process, and getOrCreateServer retries
        // (now with port fallback) on the next on-demand command invocation.
        console.warn('[opencode-pty] web server could not be started:', error)
      }
    }
  },
})

export default Plugin
