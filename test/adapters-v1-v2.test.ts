import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import type { OpencodeClient } from '@opencode-ai/sdk'
import { createV1Adapter } from '../src/adapters/v1/index.ts'
import { V1NotificationAdapter } from '../src/adapters/v1/notifications.ts'
import { type PermissionConfig, V1PermissionAuthorizer } from '../src/adapters/v1/permissions.ts'
import { createV2Adapter } from '../src/adapters/v2/index.ts'
import { manager } from '../src/plugin/pty/manager.ts'
import { setPermissionAuthorizer } from '../src/plugin/pty/permissions.ts'
import type { PTYSession } from '../src/plugin/pty/types.ts'
import type { PluginClient } from '../src/plugin/types.ts'

function notificationClient(): {
  client: OpencodeClient
  promptAsync: ReturnType<typeof mock>
} {
  const promptAsync = mock(async () => {})
  const client = {
    session: {
      get: async () => ({ data: {} }),
      promptAsync,
    },
  } as unknown as OpencodeClient
  return { client, promptAsync }
}

function permissionClient(
  result: { data?: { permission?: PermissionConfig } } | (() => Promise<unknown>)
): { client: PluginClient; showToast: ReturnType<typeof mock> } {
  const showToast = mock(async () => {})
  const get = typeof result === 'function' ? result : async () => result
  const client = {
    config: { get },
    tui: { showToast },
  } as unknown as PluginClient
  return { client, showToast }
}

function buildSession(): PTYSession {
  return {
    id: 'pty_adapter',
    title: 'Adapter session',
    command: 'echo',
    args: [],
    workdir: '/tmp',
    status: 'running',
    pid: 1,
    createdAt: new Date(),
    notifyOnExit: true,
    timedOut: false,
    parentSessionId: 'parent-adapter',
    buffer: { length: 0, read: () => [] } as unknown as PTYSession['buffer'],
    process: null,
  }
}

afterEach(() => {
  mock.restore()
  setPermissionAuthorizer(null)
  manager.setNotifier(null)
  manager.clearAllSessions()
})

describe('V1NotificationAdapter', () => {
  it('is a no-op without a client', async () => {
    const adapter = new V1NotificationAdapter()
    await expect(adapter.sendExitNotification(buildSession(), 0)).resolves.toBeUndefined()
  })

  it('initializes through the constructor and forwards exit notifications', async () => {
    const { client, promptAsync } = notificationClient()
    const adapter = new V1NotificationAdapter(client)

    await adapter.sendExitNotification(buildSession(), 0)

    expect(promptAsync).toHaveBeenCalledTimes(1)
  })

  it('initializes lazily via init()', async () => {
    const { client, promptAsync } = notificationClient()
    const adapter = new V1NotificationAdapter()
    adapter.init(client)

    await adapter.sendExitNotification(buildSession(), 3)

    expect(promptAsync).toHaveBeenCalledTimes(1)
    const payload = promptAsync.mock.calls[0]?.[0] as {
      body: { parts: Array<{ text: string }> }
    }
    expect(payload.body.parts[0]?.text).toContain('Exit Code: 3')
  })
})

describe('HostAdapter session-deletion wiring', () => {
  it('createV1Adapter forwards session deletion to cleanupBySession', () => {
    const { client } = permissionClient({})
    const adapter = createV1Adapter({
      client,
      directory: '/workspace',
    } as unknown as Parameters<typeof createV1Adapter>[0])
    const cleanupSpy = spyOn(manager, 'cleanupBySession').mockImplementation(() => {})

    adapter.onSessionDeleted?.('parent-1')

    expect(cleanupSpy).toHaveBeenCalledWith('parent-1')
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
})

describe('V1PermissionAuthorizer commands', () => {
  it('allows everything without a client', async () => {
    const authorizer = new V1PermissionAuthorizer(null, null)
    await expect(authorizer.checkCommand('rm', ['-rf', '/'])).resolves.toBeUndefined()
    await expect(authorizer.checkWorkdir('/outside')).resolves.toBeUndefined()
  })

  it('allows when no bash permission is configured', async () => {
    const { client } = permissionClient({ data: { permission: {} } })
    const authorizer = new V1PermissionAuthorizer(client, '/workspace')
    await expect(authorizer.checkCommand('echo', ['hi'])).resolves.toBeUndefined()
  })

  it('denies all commands when bash is the string "deny"', async () => {
    const { client, showToast } = permissionClient({ data: { permission: { bash: 'deny' } } })
    const authorizer = new V1PermissionAuthorizer(client, '/workspace')

    await expect(authorizer.checkCommand('echo', [])).rejects.toThrow(
      'All bash commands are disabled by user configuration.'
    )
    expect(showToast).toHaveBeenCalled()
  })

  it('treats bash string "ask" as a denial', async () => {
    const { client } = permissionClient({ data: { permission: { bash: 'ask' } } })
    const authorizer = new V1PermissionAuthorizer(client, '/workspace')

    await expect(authorizer.checkCommand('echo', [])).rejects.toThrow(
      'requires permission (treated as denied)'
    )
  })

  it('allows bash string "allow"', async () => {
    const { client } = permissionClient({ data: { permission: { bash: 'allow' } } })
    const authorizer = new V1PermissionAuthorizer(client, '/workspace')
    await expect(authorizer.checkCommand('echo', [])).resolves.toBeUndefined()
  })

  it('denies explicitly denied structured commands', async () => {
    const { client } = permissionClient({
      data: { permission: { bash: { 'git push': 'deny' } } },
    })
    const authorizer = new V1PermissionAuthorizer(client, '/workspace')

    await expect(authorizer.checkCommand('git', ['push'])).rejects.toThrow(
      'is explicitly denied by user configuration.'
    )
    await expect(authorizer.checkCommand('git', ['status'])).resolves.toBeUndefined()
  })

  it('treats structured "ask" as a denial', async () => {
    const { client } = permissionClient({
      data: { permission: { bash: { 'git push': 'ask' } } },
    })
    const authorizer = new V1PermissionAuthorizer(client, '/workspace')

    await expect(authorizer.checkCommand('git', ['push'])).rejects.toThrow(
      'requires permission (treated as denied)'
    )
  })

  it('falls back to allow when config retrieval errors', async () => {
    const { client } = permissionClient(() => {
      throw new Error('config offline')
    })
    const authorizer = new V1PermissionAuthorizer(client, '/workspace')
    await expect(authorizer.checkCommand('echo', [])).resolves.toBeUndefined()
  })

  it('falls back to allow when config returns an error payload', async () => {
    const showToast = mock(async () => {})
    const client = {
      config: { get: async () => ({ error: 'config unavailable' }) },
      tui: { showToast },
    } as unknown as PluginClient
    const authorizer = new V1PermissionAuthorizer(client, '/workspace')
    await expect(authorizer.checkCommand('echo', [])).resolves.toBeUndefined()
  })

  it('still denies when the toast call itself fails', async () => {
    const { client } = permissionClient({ data: { permission: { bash: 'deny' } } })
    ;(client.tui.showToast as unknown as ReturnType<typeof mock>).mockImplementation(async () => {
      throw new Error('tui unavailable')
    })
    const authorizer = new V1PermissionAuthorizer(client, '/workspace')

    await expect(authorizer.checkCommand('echo', [])).rejects.toThrow(
      'All bash commands are disabled by user configuration.'
    )
  })
})

describe('V1PermissionAuthorizer external directories', () => {
  it('allows workdirs inside the project directory', async () => {
    const { client } = permissionClient({ data: { permission: { external_directory: 'deny' } } })
    const authorizer = new V1PermissionAuthorizer(client, '/workspace')

    await expect(authorizer.checkWorkdir('/workspace/sub')).resolves.toBeUndefined()
    await expect(authorizer.checkWorkdir('/workspace/')).resolves.toBeUndefined()
  })

  it('denies external workdirs when external_directory is "deny"', async () => {
    const { client } = permissionClient({ data: { permission: { external_directory: 'deny' } } })
    const authorizer = new V1PermissionAuthorizer(client, '/workspace')

    await expect(authorizer.checkWorkdir('/outside')).rejects.toThrow(
      'External directory access is denied by user configuration.'
    )
  })

  it('denies external workdirs when external_directory is "ask"', async () => {
    const { client, showToast } = permissionClient({
      data: { permission: { external_directory: 'ask' } },
    })
    const authorizer = new V1PermissionAuthorizer(client, '/workspace')

    await expect(authorizer.checkWorkdir('/outside')).rejects.toThrow(
      'External directory access requires user permission which is not supported by this plugin.'
    )
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.objectContaining({ variant: 'error' }) })
    )
  })

  it('allows external workdirs when external_directory is "allow"', async () => {
    const { client } = permissionClient({
      data: { permission: { external_directory: 'allow' } },
    })
    const authorizer = new V1PermissionAuthorizer(client, '/workspace')
    await expect(authorizer.checkWorkdir('/outside')).resolves.toBeUndefined()
  })

  it('allows external workdirs when no external_directory is configured', async () => {
    const { client } = permissionClient({ data: { permission: {} } })
    const authorizer = new V1PermissionAuthorizer(client, '/workspace')
    await expect(authorizer.checkWorkdir('/outside')).resolves.toBeUndefined()
  })
})
