import { getPtyManager } from '../../plugin/pty/manager.ts'
import { logPtyEvent } from '../../plugin/pty/plugin-log.ts'
import type { HostAdapter, PermissionAuthorizer, SessionNotifier } from '../types.ts'
import { V2PermissionAuthorizer } from './permissions.ts'

export interface V2AdapterOptions {
  notifier?: SessionNotifier
  permissions?: PermissionAuthorizer
  /**
   * The host's permission domain, when the build has one.
   *
   * Passed rather than read from a global: the domain is per plugin instance, and
   * a global would hand one host's rules to another.
   */
  permission?: {
    assert: (input: {
      readonly sessionID: string
      readonly agent?: string
      readonly action: string
      readonly resources: readonly string[]
    }) => Promise<void>
  }
}

export class V2HostAdapter implements HostAdapter {
  readonly id = 'opencode-v2'
  readonly notifier?: SessionNotifier
  readonly permissions?: PermissionAuthorizer

  constructor(options: V2AdapterOptions = {}) {
    this.notifier = options.notifier
    // The host's own gate, when the host has one. Without it the plugin has no
    // gate, and the log says so instead of pretending.
    this.permissions =
      options.permissions ??
      (options.permission ? new V2PermissionAuthorizer(options.permission) : undefined)
    if (!this.permissions) {
      logPtyEvent(
        'warn',
        'host exposes no permission domain: PTY commands run without a permission check'
      )
    }
  }

  onSessionDeleted(sessionId: string): void {
    // Fire-and-forget: a daemon answers over the socket, and the host does not wait
    // for a cleanup. A rejection is logged rather than left unhandled.
    void Promise.resolve(getPtyManager().cleanupBySession(sessionId)).catch((error) => {
      logPtyEvent('warn', `cleanup of ${sessionId} failed`, error)
    })
  }
}

export function createV2Adapter(options?: V2AdapterOptions): HostAdapter {
  return new V2HostAdapter(options)
}
