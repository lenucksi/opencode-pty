import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { originsForProject } from '../src/shared/runtime.ts'
import {
  getActiveServer,
  getOrCreateServer,
  handleRestartDaemonCommand,
  handleShowServerUrlCommand,
  noticeFromData,
  type Notice,
  notifyUser,
  Plugin,
  PTY_OPEN_CLIENT_COMMAND,
  PTY_RESTART_DAEMON_COMMAND,
  PTY_SHOW_SERVER_URL_COMMAND,
  ptyTools,
  registerV2Commands,
  setNoticeEmitter,
  stopActiveServer,
} from '../src/v2/index.ts'
import type {
  CommandDefinition,
  CommandDraft,
  PluginContextV2,
  SkillDraft,
  SkillSourceV2,
  ToolDraft,
  ToolInfoV2,
} from '../src/v2/types.ts'

describe('OpenCode V2 Plugin API', () => {
  afterEach(() => {
    stopActiveServer()
  })

  describe('Plugin Contract Conformance', () => {
    it('satisfies the V2 plugin structure (id and setup)', () => {
      expect(Plugin.id).toBe('opencode-pty')
      expect(typeof Plugin.setup).toBe('function')
    })

    it('exports standard PTY tools', () => {
      expect(ptyTools.pty_spawn).toBeDefined()
      expect(ptyTools.pty_write).toBeDefined()
      expect(ptyTools.pty_read).toBeDefined()
      expect(ptyTools.pty_list).toBeDefined()
      expect(ptyTools.pty_kill).toBeDefined()
    })
  })

  describe('Tool Registration via ctx.tool.transform', () => {
    it('registers every PTY tool with name, input schema and execute', async () => {
      const registeredTools: Record<string, ToolInfoV2> = {}

      const draft: ToolDraft = {
        add: (tool) => {
          registeredTools[tool.name] = tool
        },
      }

      const mockTransform = mock(async (callback: (draft: ToolDraft) => void) => {
        callback(draft)
      })

      const ctx: PluginContextV2 = {
        options: {},
        tool: {
          transform: mockTransform,
        },
      }

      await Plugin.setup(ctx)

      expect(mockTransform).toHaveBeenCalled()
      expect(Object.keys(registeredTools).sort()).toEqual([
        'pty_kill',
        'pty_list',
        'pty_read',
        'pty_resize',
        'pty_screen',
        'pty_spawn',
        'pty_wait',
        'pty_write',
      ])

      for (const tool of Object.values(registeredTools)) {
        expect(typeof tool.description).toBe('string')
        expect(tool.description.length).toBeGreaterThan(0)
        expect(tool.input).toBeDefined()
        expect(typeof tool.execute).toBe('function')
      }
    })

    it('does not fail when the tool transform is unavailable', async () => {
      const ctx: PluginContextV2 = { options: {} }
      await Plugin.setup(ctx)
      expect(getActiveServer()).toBeNull()
    })
  })

  describe('Skill Registration via ctx.skill.transform', () => {
    it('registers the embedded pty-usage skill', async () => {
      const registered: SkillSourceV2[] = []

      const draft: SkillDraft = {
        source: (source) => {
          registered.push(source)
        },
      }

      const mockTransform = mock(async (callback: (draft: SkillDraft) => void) => {
        callback(draft)
      })

      const ctx: PluginContextV2 = {
        options: {},
        skill: {
          transform: mockTransform,
        },
      }

      await Plugin.setup(ctx)

      expect(mockTransform).toHaveBeenCalled()
      expect(registered).toHaveLength(1)

      const [first] = registered
      if (first?.type !== 'embedded') {
        throw new Error('expected an embedded skill source')
      }
      expect(first.skill.name).toBe('pty-usage')
      expect(first.skill.description?.length ?? 0).toBeGreaterThan(20)
      // The detailed guide lives in the skill, so it should be substantial.
      expect(first.skill.content.length).toBeGreaterThan(500)
      expect(first.skill.content).toContain('pty_wait')
    })

    it('does not fail when the skill transform is unavailable', async () => {
      const ctx: PluginContextV2 = { options: {} }
      await Plugin.setup(ctx)
      expect(getActiveServer()).toBeNull()
    })
  })

  describe('Command Registration via ctx.command.transform', () => {
    it('registers slash commands with an execute handler', async () => {
      const registeredCommands: Record<string, CommandDefinition> = {}

      const draft: CommandDraft = {
        add: (command) => {
          registeredCommands[command.name] = command
        },
      }

      const mockTransform = mock(async (callback: (draft: CommandDraft) => void) => {
        callback(draft)
      })

      const ctx: PluginContextV2 = {
        options: {},
        command: {
          transform: mockTransform,
        },
      }

      await Plugin.setup(ctx)

      expect(mockTransform).toHaveBeenCalled()
      expect(registeredCommands[PTY_OPEN_CLIENT_COMMAND]?.description).toBe(
        'Open PTY Sessions Web Interface'
      )
      expect(typeof registeredCommands[PTY_OPEN_CLIENT_COMMAND]?.execute).toBe('function')
      expect(registeredCommands[PTY_SHOW_SERVER_URL_COMMAND]?.description).toBe(
        'Show PTY Sessions Web Interface URL'
      )
      expect(typeof registeredCommands[PTY_SHOW_SERVER_URL_COMMAND]?.execute).toBe('function')
      expect(registeredCommands[PTY_RESTART_DAEMON_COMMAND]?.description).toBe(
        'Restart the PTY daemon (ends every running PTY session)'
      )
      expect(typeof registeredCommands[PTY_RESTART_DAEMON_COMMAND]?.execute).toBe('function')
    })
  })

  describe('Daemon restart command', () => {
    // The daemon on this machine is shared by every opencode instance, so a test
    // that looked for it would find the REAL one - and roll it. The runtime
    // directory is what says where the daemon lives, so an empty one says "there
    // is none".
    let previousRuntimeDir: string | undefined
    let emptyRuntimeDir: string

    beforeEach(() => {
      previousRuntimeDir = process.env.XDG_RUNTIME_DIR
      emptyRuntimeDir = mkdtempSync(join(tmpdir(), 'opencode-pty-no-daemon-'))
      process.env.XDG_RUNTIME_DIR = emptyRuntimeDir
    })

    afterEach(() => {
      setNoticeEmitter(null)
      if (previousRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR
      else process.env.XDG_RUNTIME_DIR = previousRuntimeDir
      rmSync(emptyRuntimeDir, { recursive: true, force: true })
    })

    it('says there is nothing to restart when the machine has no daemon', async () => {
      const message = await handleRestartDaemonCommand()
      expect(message).toContain('no PTY daemon on this machine')
      expect(message).toContain('nothing to restart')
    })

    // The host drops a command's result, so the message alone reaches nobody. The
    // notice is what the reader sees.
    it('says what it did, where a reader can see it', async () => {
      const notices: Notice[] = []
      setNoticeEmitter((notice) => notices.push(notice))

      await handleRestartDaemonCommand()

      expect(notices).toHaveLength(1)
      expect(notices[0]?.message).toContain('nothing to restart')
      expect(notices[0]?.variant).toBe('warning')
    })

    it('is runnable through the registered command', async () => {
      const registered: Record<string, CommandDefinition> = {}
      const draft: CommandDraft = {
        add: (command) => {
          registered[command.name] = command
        },
      }
      registerV2Commands(draft)
      await registered[PTY_RESTART_DAEMON_COMMAND]?.execute({})
      expect(registered[PTY_RESTART_DAEMON_COMMAND]?.description).toBe(
        'Restart the PTY daemon (ends every running PTY session)'
      )
    })

    it('does nothing when the draft has no add()', () => {
      expect(() => registerV2Commands({} as CommandDraft)).not.toThrow()
    })
  })

  describe('The notice channel', () => {
    afterEach(() => {
      setNoticeEmitter(null)
    })

    it('says the web interface address, where a reader can see it', async () => {
      const notices: Notice[] = []
      setNoticeEmitter((notice) => notices.push(notice))

      const message = await handleShowServerUrlCommand()

      expect(message).toContain('http')
      expect(notices).toHaveLength(1)
      expect(notices[0]?.message).toContain('http')
    })

    it('carries a message and a variant', () => {
      expect(noticeFromData({ message: 'done', variant: 'success' })).toEqual({
        message: 'done',
        variant: 'success',
      })
    })

    it('drops what is not a notice', () => {
      expect(noticeFromData(undefined)).toBeNull()
      expect(noticeFromData('a string')).toBeNull()
      expect(noticeFromData({ variant: 'info' })).toBeNull()
      expect(noticeFromData({ message: '' })).toBeNull()
    })

    it('falls back to info for a variant it does not know', () => {
      expect(noticeFromData({ message: 'done', variant: 'chartreuse' })).toEqual({
        message: 'done',
        variant: 'info',
      })
    })

    it('loses nothing when nobody is listening', () => {
      expect(() => notifyUser('done')).not.toThrow()
    })

    it('does not fail the action when the channel throws', () => {
      setNoticeEmitter(() => {
        throw new Error('the channel is gone')
      })
      expect(() => notifyUser('done')).not.toThrow()
    })
  })

  describe('The daemon roll over the plugin RPC', () => {
    // The daemon on this machine is shared by every opencode instance, so a test
    // that looked for it would find the REAL one - and roll it. The runtime
    // directory is what says where the daemon lives, so an empty one says "there
    // is none".
    let previousRuntimeDir: string | undefined
    let emptyRuntimeDir: string

    beforeEach(() => {
      previousRuntimeDir = process.env.XDG_RUNTIME_DIR
      emptyRuntimeDir = mkdtempSync(join(tmpdir(), 'opencode-pty-no-daemon-'))
      process.env.XDG_RUNTIME_DIR = emptyRuntimeDir
    })

    afterEach(() => {
      setNoticeEmitter(null)
      if (previousRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR
      else process.env.XDG_RUNTIME_DIR = previousRuntimeDir
      rmSync(emptyRuntimeDir, { recursive: true, force: true })
    })

    /**
     * The plugin's own RPC, with the handlers it registered.
     *
     * The TUI half and the web interface ask for the roll this way, so the
     * methods are what those surfaces actually reach.
     */
    async function registeredMethods(): Promise<
      Record<string, (input: unknown, context: unknown) => Promise<unknown>>
    > {
      const methods: Record<string, (input: unknown, context: unknown) => Promise<unknown>> = {}
      const ctx: PluginContextV2 = {
        options: {},
        rpc: {
          register: async (
            _definition: unknown,
            handlers: Record<string, (input: unknown, context: unknown) => Promise<unknown>>
          ) => {
            Object.assign(methods, handlers)
            return { events: { emit: async () => {} } }
          },
        } as unknown as PluginContextV2['rpc'],
      }
      await Plugin.setup(ctx)
      return methods
    }

    it('rolls the daemon for a surface that is not the server', async () => {
      const methods = await registeredMethods()

      const answer = await methods.restartDaemon?.({}, {})

      // No daemon on this machine, so nothing was rolled - and the answer says so
      // rather than claiming a pid.
      expect(answer).toEqual({ oldPid: 0, newPid: 0, restarted: false })
    })

    // The footer's line shows the pid of the daemon that is running. A machine
    // without one is a working machine - the PTY service runs in-process - so the
    // answer is 0 rather than an error.
    it('reports no daemon as 0, not as a failure', async () => {
      const methods = await registeredMethods()

      const answer = await methods.daemonStatus?.({}, {})

      expect(answer).toEqual({ pid: 0 })
    })

    it('says where the server is, or that there is none', async () => {
      const methods = await registeredMethods()

      const answer = await methods.origin?.(
        {},
        {
          error: (name: string, message: string) => ({ error: name, message }),
        }
      )

      expect(answer).toEqual({
        error: 'not_running',
        message: 'No PTY server is running yet',
      })
    })
  })

  describe('Options Support (Custom Port & Hostname)', () => {
    it('creates server with custom port and hostname when specified', async () => {
      const server = await getOrCreateServer({ port: 0, hostname: '127.0.0.1' })
      expect(server).toBeDefined()
      expect(server.server.url.protocol).toBe('http:')
      expect(server.server.url.hostname).toBe('127.0.0.1')
    })

    it('autostarts server when autostart option is true in ctx.options', async () => {
      expect(getActiveServer()).toBeNull()

      const ctx: PluginContextV2 = {
        options: {
          autostart: true,
          hostname: '127.0.0.1',
        },
      }

      await Plugin.setup(ctx)

      const active = getActiveServer()
      expect(active).not.toBeNull()
      expect(active?.server.url.hostname).toBe('127.0.0.1')
    })

    it('publishes a findable origin, because the context says where the project is', async () => {
      // The line under test is the pass-through in the autostart branch: with
      // it, a TUI in this project can look the server up; without it, the server
      // publishes nothing at all and the sidebar has no way to find it.
      const runtime = mkdtempSync(join(tmpdir(), 'pty-v2-runtime-'))
      // realpathSync: the record is keyed on the canonical path, and /var is a
      // symlink on some hosts, so a raw temp path would not match.
      const project = realpathSync(mkdtempSync(join(tmpdir(), 'pty-v2-project-')))
      const previous = process.env.PTY_RUNTIME_DIR
      process.env.PTY_RUNTIME_DIR = runtime

      try {
        const ctx: PluginContextV2 = {
          options: { autostart: true, hostname: '127.0.0.1' },
          location: { directory: project },
        }
        await Plugin.setup(ctx)

        const records = originsForProject(project)
        expect(records).toHaveLength(1)
        expect(records[0]?.port).toBe(getActiveServer()?.server.port)
      } finally {
        stopActiveServer()
        if (previous === undefined) delete process.env.PTY_RUNTIME_DIR
        else process.env.PTY_RUNTIME_DIR = previous
        rmSync(runtime, { recursive: true, force: true })
        rmSync(project, { recursive: true, force: true })
      }
    })

    it('shows server URL via handleShowServerUrlCommand', async () => {
      const message = await handleShowServerUrlCommand({ hostname: '127.0.0.1' })
      expect(message).toContain('PTY Sessions Web Interface URL: http://127.0.0.1:')
    })
  })
})
