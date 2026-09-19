import {
  registerRawOutputCallback,
  registerSessionUpdateCallback,
  removeRawOutputCallback,
  removeSessionUpdateCallback,
} from '../../plugin/pty/manager'
import type { PTYSessionInfo } from '../../plugin/pty/types'
import type { WSMessageServerSessionUpdate, WSMessageServerRawData } from '../shared/types'

export class CallbackManager implements Disposable {
  constructor(private server: Bun.Server<undefined>) {
    registerSessionUpdateCallback(this.sessionUpdateCallback)
    registerRawOutputCallback(this.rawOutputCallback)
  }

  private sessionUpdateCallback = (session: PTYSessionInfo): void => {
    const message: WSMessageServerSessionUpdate = { type: 'session_update', session }
    this.server.publish('sessions:update', JSON.stringify(message))
  }

  private rawOutputCallback = (sessionId: string, rawData: string, offset: number): void => {
    const message: WSMessageServerRawData = { type: 'raw_data', sessionId, rawData, offset }
    this.server.publish(`session:${sessionId}`, JSON.stringify(message))
  };

  [Symbol.dispose]() {
    removeSessionUpdateCallback(this.sessionUpdateCallback)
    removeRawOutputCallback(this.rawOutputCallback)
  }
}
