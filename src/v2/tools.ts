import { tool } from '@opencode-ai/plugin'
import { ptyKill } from '../plugin/pty/tools/kill.ts'
import { ptyList } from '../plugin/pty/tools/list.ts'
import { ptyRead } from '../plugin/pty/tools/read.ts'
import { ptyResize } from '../plugin/pty/tools/resize.ts'
import { ptyScreen } from '../plugin/pty/tools/screen.ts'
import { ptySpawn } from '../plugin/pty/tools/spawn.ts'
import { ptyWait } from '../plugin/pty/tools/wait.ts'
import { ptyWrite } from '../plugin/pty/tools/write.ts'
import type { ToolDraft, ToolInfoV2 } from './types.ts'

export const ptyTools = {
  pty_spawn: ptySpawn,
  pty_write: ptyWrite,
  pty_read: ptyRead,
  pty_list: ptyList,
  pty_kill: ptyKill,
  pty_wait: ptyWait,
  pty_resize: ptyResize,
  pty_screen: ptyScreen,
} as const

export type PTYToolName = keyof typeof ptyTools

type V1ToolDefinition = {
  description: string
  args: Record<string, unknown>
  execute: (args: never, context: never) => Promise<string>
}

/**
 * Registers the PTY tools with opencode v2's `ToolEditor`.
 *
 * The tool definitions are authored against the V1 `tool()` helper
 * (`{ description, args, execute }`). opencode v2 expects `Tool.Info`
 * (`{ name, input, description, execute }`); we adapt:
 *   - `args` (Zod raw shape) -> `input`: JSON Schema (Zod v4 `toJSONSchema`)
 *   - string result -> `{ content }`
 */
export function registerV2Tools(draft: ToolDraft): void {
  if (typeof draft.add !== 'function') {
    return
  }
  const add = draft.add.bind(draft)
  // Two different tool APIs meet here. `ptyTools` holds V2 `tool()` objects,
  // whose `execute` takes the V2 context and may answer with a `ToolResult`;
  // `V1ToolDefinition` is the V1 shape this loop re-exports for the host.
  // A single assertion is rejected because the parameter types are contravariant.
  // aislop-ignore-next-line ai-slop/double-type-assertion -- bridging the V2 tool API to the V1 shape it is re-exported in
  const tools = ptyTools as unknown as Record<string, V1ToolDefinition>

  for (const [name, definition] of Object.entries(tools)) {
    const info: ToolInfoV2 = {
      name,
      description: definition.description,
      input: tool.schema.toJSONSchema(tool.schema.object(definition.args)),
      execute: async (input, context) => {
        const result = await definition.execute(input as never, context as never)
        return typeof result === 'string' ? { content: result } : result
      },
    }
    add(info)
  }
}
