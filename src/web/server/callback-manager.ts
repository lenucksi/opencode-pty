import {
  registerRawOutputCallback,
  registerSessionRemovedCallback,
  registerSessionUpdateCallback,
  removeRawOutputCallback,
  removeSessionRemovedCallback,
  removeSessionUpdateCallback,
} from '../../plugin/pty/manager'
import type { PTYSessionInfo } from '../../plugin/pty/types'
import type {
  WSMessageServerSessionRemoved,
  WSMessageServerSessionUpdate,
  WSMessageServerRawData,
} from '../shared/types'

export class CallbackManager implements Disposable {
  constructor(private server: Bun.Server<undefined>) {
    registerSessionUpdateCallback(this.sessionUpdateCallback)
    registerRawOutputCallback(this.rawOutputCallback)
    registerSessionRemovedCallback(this.sessionRemovedCallback)
  }

  private sessionUpdateCallback = (session: PTYSessionInfo): void => {
    const message: WSMessageServerSessionUpdate = { type: 'session_update', session }
    this.server.publish('sessions:update', JSON.stringify(message))
  }

  private sessionRemovedCallback = (sessionId: string): void => {
    const message: WSMessageServerSessionRemoved = { type: 'session_removed', sessionId }
    this.server.publish('sessions:update', JSON.stringify(message))
  }

  private rawOutputCallback = (sessionId: string, rawData: string, offset: number): void => {
    const message: WSMessageServerRawData = { type: 'raw_data', sessionId, rawData, offset }
    this.server.publish(`session:${sessionId}`, JSON.stringify(message))
  };

  [Symbol.dispose]() {
    removeSessionUpdateCallback(this.sessionUpdateCallback)
    removeRawOutputCallback(this.rawOutputCallback)
    removeSessionRemovedCallback(this.sessionRemovedCallback)
  }
}
