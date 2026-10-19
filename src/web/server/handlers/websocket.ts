import type { ServerWebSocket } from 'bun'
import { getPtyManager } from '../../../plugin/pty/manager.ts'
import { checkCommandPermission, checkWorkdirPermission } from '../../../plugin/pty/permissions'
import {
  CustomError,
  type WSMessageClient,
  type WSMessageClientInput,
  type WSMessageClientReadRaw,
  type WSMessageClientResize,
  type WSMessageClientSessionList,
  type WSMessageClientSpawnSession,
  type WSMessageClientSubscribeSession,
  type WSMessageClientUnsubscribeSession,
  type WSMessageServerError,
  type WSMessageServerReadRawResponse,
  type WSMessageServerSessionList,
  type WSMessageServerSubscribedSession,
  type WSMessageServerUnsubscribedSession,
} from '../../shared/types'

class WebSocketHandler {
  private async sendSessionList(ws: ServerWebSocket<undefined>): Promise<void> {
    const sessions = await getPtyManager().list()
    const message: WSMessageServerSessionList = { type: 'session_list', sessions }
    ws.send(JSON.stringify(message))
  }

  private async handleSubscribe(
    ws: ServerWebSocket<undefined>,
    message: WSMessageClientSubscribeSession
  ): Promise<void> {
    const session = await getPtyManager().get(message.sessionId)
    if (!session) {
      const error: WSMessageServerError = {
        type: 'error',
        error: new CustomError(`Session ${message.sessionId} not found`),
      }
      ws.send(JSON.stringify(error))
    } else {
      ws.subscribe(`session:${message.sessionId}`)
      const response: WSMessageServerSubscribedSession = {
        type: 'subscribed',
        sessionId: message.sessionId,
      }
      ws.send(JSON.stringify(response))
    }
  }

  private handleUnsubscribe(
    ws: ServerWebSocket<undefined>,
    message: WSMessageClientUnsubscribeSession
  ): void {
    const topic = `session:${message.sessionId}`
    ws.unsubscribe(topic)
    const response: WSMessageServerUnsubscribedSession = {
      type: 'unsubscribed',
      sessionId: message.sessionId,
    }
    ws.send(JSON.stringify(response))
  }

  private async handleSessionListRequest(
    ws: ServerWebSocket<undefined>,
    _message: WSMessageClientSessionList
  ): Promise<void> {
    await this.sendSessionList(ws)
  }

  private handleUnknownMessage(ws: ServerWebSocket<undefined>, message: WSMessageClient): void {
    const error: WSMessageServerError = {
      type: 'error',
      error: new CustomError(`Unknown message type ${message.type}`),
    }
    ws.send(JSON.stringify(error))
  }

  public async handleWebSocketMessage(
    ws: ServerWebSocket<undefined>,
    data: string | Buffer<ArrayBuffer>
  ): Promise<void> {
    if (typeof data !== 'string') {
      const error: WSMessageServerError = {
        type: 'error',
        error: new CustomError('Binary messages are not supported yet. File an issue.'),
      }
      ws.send(JSON.stringify(error))
      return
    }
    try {
      const message: WSMessageClient = JSON.parse(data)

      switch (message.type) {
        case 'subscribe':
          await this.handleSubscribe(ws, message as WSMessageClientSubscribeSession)
          break

        case 'unsubscribe':
          this.handleUnsubscribe(ws, message as WSMessageClientUnsubscribeSession)
          break

        case 'session_list':
          await this.handleSessionListRequest(ws, message as WSMessageClientSessionList)
          break

        case 'spawn':
          void this.handleSpawn(ws, message as WSMessageClientSpawnSession)
          break

        case 'input':
          await this.handleInput(message as WSMessageClientInput)
          break

        case 'readRaw':
          await this.handleReadRaw(ws, message as WSMessageClientReadRaw)
          break

        case 'resize':
          await this.handleResize(ws, message as WSMessageClientResize)
          break

        default:
          this.handleUnknownMessage(ws, message)
      }
    } catch (err) {
      const error: WSMessageServerError = {
        type: 'error',
        error: new CustomError(Bun.inspect(err)),
      }
      ws.send(JSON.stringify(error))
    }
  }

  private async handleSpawn(ws: ServerWebSocket<undefined>, message: WSMessageClientSpawnSession) {
    try {
      await checkCommandPermission(message.command, message.args ?? [])
      if (message.workdir) {
        await checkWorkdirPermission(message.workdir)
      }

      const sessionInfo = await getPtyManager().spawn(message)
      if (message.subscribe) {
        await this.handleSubscribe(ws, { type: 'subscribe', sessionId: sessionInfo.id })
      }
    } catch (err) {
      const error: WSMessageServerError = {
        type: 'error',
        error: new CustomError(err instanceof Error ? err.message : Bun.inspect(err)),
      }
      ws.send(JSON.stringify(error))
    }
  }

  private async handleInput(message: WSMessageClientInput): Promise<void> {
    await getPtyManager().write(message.sessionId, message.data)
  }

  private async handleResize(
    ws: ServerWebSocket<undefined>,
    message: WSMessageClientResize
  ): Promise<void> {
    // Recorded before the resize is attempted: this message is the only place the
    // server learns how big a human's terminal pane is, and a later agent-spawned
    // session should inherit that rather than a constant.
    getPtyManager().noteClientSize(message.cols, message.rows)
    const resized = await getPtyManager().resize(message.sessionId, message.cols, message.rows)
    if (!resized) {
      const error: WSMessageServerError = {
        type: 'error',
        error: new CustomError(`Session ${message.sessionId} not found`),
      }
      ws.send(JSON.stringify(error))
    }
  }

  private async handleReadRaw(
    ws: ServerWebSocket<undefined>,
    message: WSMessageClientReadRaw
  ): Promise<void> {
    const rawData = await getPtyManager().getRawBuffer(message.sessionId)
    if (!rawData) {
      const error: WSMessageServerError = {
        type: 'error',
        error: new CustomError(`Session ${message.sessionId} not found`),
      }
      ws.send(JSON.stringify(error))
      return
    }
    const response: WSMessageServerReadRawResponse = {
      type: 'readRawResponse',
      sessionId: message.sessionId,
      rawData: rawData.raw,
    }
    ws.send(JSON.stringify(response))
  }
}

export async function handleWebSocketMessage(
  ws: ServerWebSocket<undefined>,
  data: string | Buffer<ArrayBuffer>
): Promise<void> {
  const handler = new WebSocketHandler()
  await handler.handleWebSocketMessage(ws, data)
}
