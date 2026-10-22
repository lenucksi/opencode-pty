import type { ToolContext, ToolDefinition, ToolResult } from '@opencode-ai/plugin'

import { ptyKill } from './kill.ts'
import { ptyList } from './list.ts'
import { ptyRead } from './read.ts'
import { ptyResize } from './resize.ts'
import { ptyScreen } from './screen.ts'
import { ptySpawn } from './spawn.ts'
import { ptyWait } from './wait.ts'
import { ptyWrite } from './write.ts'

/**
 * One PTY tool, as a route sees it.
 *
 * The concrete tools are typed with their own argument shapes; this is the shape
 * that lets a route handle any of them. The arguments are `never` because the
 * route hands over what the harness sent and the tool validates it - the schema is
 * what says what a valid argument is, and both routes publish it.
 */
export interface PtyTool {
  readonly description: string
  readonly args: ToolDefinition['args']
  readonly execute: (args: never, context: ToolContext) => Promise<ToolResult>
}

const table = {
  pty_spawn: ptySpawn,
  pty_write: ptyWrite,
  pty_read: ptyRead,
  pty_list: ptyList,
  pty_kill: ptyKill,
  pty_wait: ptyWait,
  pty_resize: ptyResize,
  pty_screen: ptyScreen,
}

/**
 * The eight tools, in one place.
 *
 * Both routes that offer them - the OpenCode plugin and the MCP server - register
 * this table, so a tool that exists in one exists in the other. The route decides
 * how it is announced and who may call it; the tool is the same.
 */
export const ptyTools: Record<keyof typeof table, PtyTool> = table

export type PTYToolName = keyof typeof table
