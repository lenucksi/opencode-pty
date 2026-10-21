import open from 'open'
import { restartDaemon } from '../plugin/pty/manager.ts'
import { PTYServer, type ServerOptions } from '../web/server/server.ts'
import { notifyUser } from './rpc.ts'
import type { CommandDraft, OpencodePtyOptions } from './types.ts'

export const PTY_OPEN_CLIENT_COMMAND = 'pty-open-background-spy'
export const PTY_SHOW_SERVER_URL_COMMAND = 'pty-show-server-url'
export const PTY_RESTART_DAEMON_COMMAND = 'pty-daemon-restart'

let activeServer: PTYServer | null = null

export async function getOrCreateServer(options?: ServerOptions): Promise<PTYServer> {
  if (!activeServer) {
    activeServer = await PTYServer.createServer(options)
  }
  return activeServer
}

export function getActiveServer(): PTYServer | null {
  return activeServer
}

export function stopActiveServer(): void {
  if (activeServer) {
    activeServer[Symbol.dispose]()
    activeServer = null
  }
}

export async function handleOpenClientCommand(options?: ServerOptions): Promise<string> {
  const server = await getOrCreateServer(options)
  const url = server.server.url.origin
  open(url)
  const message = `PTY Sessions Web Interface opened at: ${url}`
  notifyUser(message, 'success')
  return message
}

export async function handleShowServerUrlCommand(options?: ServerOptions): Promise<string> {
  const server = await getOrCreateServer(options)
  const message = `PTY Sessions Web Interface URL: ${server.server.url.origin}`
  notifyUser(message, 'info')
  return message
}

/**
 * Restart the daemon from the command line.
 *
 * The daemon outlives the host by design, which is also why a rebuilt daemon does
 * not take effect on a host restart - this is the way to roll it. It ends every
 * session the daemon owns, so the description says so.
 *
 * Every command here says what it did, because the host drops a command's result:
 * a command that works and a command that did nothing look the same otherwise.
 */
export async function handleRestartDaemonCommand(): Promise<string> {
  const { oldPid, newPid } = await restartDaemon()
  if (oldPid === null && newPid === null) {
    const message = 'There is no PTY daemon on this machine, so there was nothing to restart.'
    notifyUser(message, 'warning')
    return message
  }
  const message = `PTY daemon restarted: old pid ${oldPid ?? 'none'}, new pid ${newPid ?? 'none'}.`
  notifyUser(message, 'success')
  return message
}

/**
 * Registers the PTY slash commands with opencode v2's `CommandEditor`.
 *
 * opencode v2's `command.transform` draft exposes `add(definition)` only
 * (there is no `update`), so commands must be created with an `execute`
 * handler rather than "updated".
 */
export function registerV2Commands(draft: CommandDraft, options?: OpencodePtyOptions): void {
  if (typeof draft.add !== 'function') {
    return
  }
  const add = draft.add.bind(draft)

  add({
    name: PTY_OPEN_CLIENT_COMMAND,
    description: 'Open PTY Sessions Web Interface',
    execute: async () => {
      await handleOpenClientCommand(options)
    },
  })

  add({
    name: PTY_SHOW_SERVER_URL_COMMAND,
    description: 'Show PTY Sessions Web Interface URL',
    execute: async () => {
      await handleShowServerUrlCommand(options)
    },
  })

  add({
    name: PTY_RESTART_DAEMON_COMMAND,
    description: 'Restart the PTY daemon (ends every running PTY session)',
    execute: async () => {
      await handleRestartDaemonCommand()
    },
  })
}
