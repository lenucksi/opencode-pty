import { getPtyManager } from '../../plugin/pty/manager.ts'
import { logPtyEvent } from '../../plugin/pty/plugin-log.ts'
import type { HostAdapter, PermissionAuthorizer, SessionNotifier } from '../types.ts'

export interface V2AdapterOptions {
  notifier?: SessionNotifier
  permissions?: PermissionAuthorizer
}

export class V2HostAdapter implements HostAdapter {
  readonly id = 'opencode-v2'
  readonly notifier?: SessionNotifier
  readonly permissions?: PermissionAuthorizer

  constructor(options: V2AdapterOptions = {}) {
    this.notifier = options.notifier
    this.permissions = options.permissions
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
