import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import {
  type HostAdapter,
  installHostAdapter,
  type PermissionAuthorizer,
  type SessionNotifier,
} from '../src/adapters/index.ts'
import { createV2Adapter } from '../src/adapters/v2/index.ts'
import { V2PermissionAuthorizer } from '../src/adapters/v2/permissions.ts'
import { manager } from '../src/plugin/pty/manager.ts'
import {
  checkCommandPermission,
  checkWorkdirPermission,
  getPermissionAuthorizer,
  setPermissionAuthorizer,
} from '../src/plugin/pty/permissions.ts'
import type { PTYSession } from '../src/plugin/pty/types.ts'

/**
 * A host that evaluates its own rules.
 *
 * The point of the V2 route is that the question is asked of the host: it knows
 * the rules per session, and it prompts the user when approval is required. A
 * plugin cannot do either.
 */
function hostPermission() {
  const assert = mock(
    async (_input: {
      readonly sessionID: string
      readonly agent?: string
      readonly action: string
      readonly resources: readonly string[]
    }) => {}
  )
  return { assert }
}

describe('Adapter Layer', () => {
  afterEach(() => {
    setPermissionAuthorizer(null)
    manager.setNotifier(null)
    manager.clearAllSessions()
  })

  describe('PermissionAuthorizer decoupling', () => {
    it('delegates command and workdir checks to custom authorizer without PluginClient', async () => {
      const checkCommand = mock(async (_cmd: string, _args: string[]) => {})
      const checkWorkdir = mock(async (_dir: string) => {})

      const customAuthorizer: PermissionAuthorizer = {
        checkCommand,
        checkWorkdir,
      }

      setPermissionAuthorizer(customAuthorizer)
      expect(getPermissionAuthorizer()).toBe(customAuthorizer)

      await checkCommandPermission('ls', ['-la'])
      expect(checkCommand).toHaveBeenCalledWith('ls', ['-la'], undefined)

      await checkWorkdirPermission('/some/dir')
      expect(checkWorkdir).toHaveBeenCalledWith('/some/dir', undefined)
    })

    it('passes the subject along, so the host can answer for that session', async () => {
      const checkCommand = mock(async (_cmd: string, _args: string[]) => {})
      setPermissionAuthorizer({ checkCommand, checkWorkdir: async () => {} })

      await checkCommandPermission('ls', ['-la'], { sessionID: 'ses_1', agent: 'build' })

      expect(checkCommand).toHaveBeenCalledWith('ls', ['-la'], {
        sessionID: 'ses_1',
        agent: 'build',
      })
    })

    it('propagates authorization errors from custom authorizer', async () => {
      const customAuthorizer: PermissionAuthorizer = {
        checkCommand: async () => {
          throw new Error('Command execution denied by security policy')
        },
        checkWorkdir: async () => {},
      }

      setPermissionAuthorizer(customAuthorizer)

      expect(checkCommandPermission('rm', ['-rf', '/'])).rejects.toThrow(
        'Command execution denied by security policy'
      )
    })

    it('safely allows when no authorizer is set', async () => {
      setPermissionAuthorizer(null)
      expect(getPermissionAuthorizer()).toBeNull()

      await expect(checkCommandPermission('echo', ['hello'])).resolves.toBeUndefined()
      await expect(checkWorkdirPermission('/anywhere')).resolves.toBeUndefined()
    })
  })

  describe('The V2 authorizer asks the host', () => {
    it('asks the host about the command, with the session it belongs to', async () => {
      const permission = hostPermission()
      const authorizer = new V2PermissionAuthorizer(permission)

      await authorizer.checkCommand('git', ['status'], { sessionID: 'ses_1', agent: 'build' })

      expect(permission.assert).toHaveBeenCalledWith({
        sessionID: 'ses_1',
        agent: 'build',
        action: 'bash',
        resources: ['git status'],
      })
    })

    it('asks the host about a working directory outside the project', async () => {
      const permission = hostPermission()
      const authorizer = new V2PermissionAuthorizer(permission)

      await authorizer.checkWorkdir('/elsewhere', { sessionID: 'ses_1' })

      expect(permission.assert).toHaveBeenCalledWith({
        sessionID: 'ses_1',
        action: 'external_directory',
        resources: ['/elsewhere'],
      })
    })

    // A host knows its rules per session, so a caller with no session has nothing
    // to ask about - and a rule nobody can be asked about is not a rule.
    it('asks nothing when the caller has no session', async () => {
      const permission = hostPermission()
      const authorizer = new V2PermissionAuthorizer(permission)

      await authorizer.checkCommand('git', ['status'])
      await authorizer.checkWorkdir('/elsewhere')

      expect(permission.assert).not.toHaveBeenCalled()
    })

    it("lets the host's refusal through", async () => {
      const permission = hostPermission()
      permission.assert.mockImplementation(async () => {
        throw new Error('rejected permission')
      })
      const authorizer = new V2PermissionAuthorizer(permission)

      await expect(
        authorizer.checkCommand('rm', ['-rf', '/'], { sessionID: 'ses_1' })
      ).rejects.toThrow('rejected permission')
    })
  })

  describe('SessionNotifier decoupling', () => {
    it('dispatches exit notifications to custom SessionNotifier without OpencodeClient', async () => {
      let notifiedSession: PTYSession | null = null
      let notifiedExitCode: number | null = null

      const customNotifier: SessionNotifier = {
        sendExitNotification: (session, exitCode) => {
          notifiedSession = session
          notifiedExitCode = exitCode
        },
      }

      manager.setNotifier(customNotifier)

      const info = manager.spawn({
        command: 'echo',
        args: ['decoupled-test'],
        description: 'Test decoupled notifier',
        parentSessionId: 'parent-123',
        notifyOnExit: true,
      })

      // Wait briefly for process to exit and notify
      await new Promise((resolve) => setTimeout(resolve, 150))

      expect(notifiedSession).not.toBeNull()
      expect((notifiedSession as PTYSession | null)?.id).toBe(info.id)
      expect(notifiedExitCode as number | null).toBe(0)
    })
  })

  describe('HostAdapter integration', () => {
    it('installHostAdapter wires both notifier and permissions', () => {
      const customNotifier: SessionNotifier = {
        sendExitNotification: () => {},
      }
      const customPermissions: PermissionAuthorizer = {
        checkCommand: async () => {},
        checkWorkdir: async () => {},
      }

      const testAdapter: HostAdapter = {
        id: 'test-adapter',
        notifier: customNotifier,
        permissions: customPermissions,
      }

      installHostAdapter(testAdapter)

      expect(getPermissionAuthorizer()).toBe(customPermissions)
      expect(manager.getNotifier()).toBe(customNotifier)
    })

    it('createV2Adapter forwards session deletion and options', () => {
      const notifier = { sendExitNotification: () => {} }
      const permissions = {
        checkCommand: async () => {},
        checkWorkdir: async () => {},
      }
      const adapter = createV2Adapter({ notifier, permissions })
      const cleanupSpy = spyOn(manager, 'cleanupBySession').mockImplementation(() => {})

      expect(adapter.id).toBe('opencode-v2')
      expect(adapter.notifier).toBe(notifier)
      expect(adapter.permissions).toBe(permissions)

      adapter.onSessionDeleted?.('parent-2')

      expect(cleanupSpy).toHaveBeenCalledWith('parent-2')
    })

    it("createV2Adapter takes the host's permission domain when it has one", () => {
      const permission = hostPermission()
      const adapter = createV2Adapter({ permission })

      expect(adapter.permissions).toBeInstanceOf(V2PermissionAuthorizer)
    })
  })
})
