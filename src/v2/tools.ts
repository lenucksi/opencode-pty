import { tool } from '@opencode-ai/plugin'
import { ptyTools, type PTYToolName } from '../plugin/pty/tools/all.ts'
import { describeForRoute } from '../plugin/pty/tools/description.ts'
import type { ToolDraft, ToolInfoV2 } from './types.ts'

export { ptyTools }
export type { PTYToolName }

/**
 * The JSON Schema of a tool's arguments.
 *
 * The tool's own schema is the source: zod turns it into JSON Schema, and the
 * result is what a harness validates the arguments against. Both routes use this,
 * so a tool that OpenCode accepts is a tool an MCP client accepts.
 */
export function toolInputSchema(definition: {
  description: string
  args: Parameters<typeof tool.schema.object>[0]
}): {
  type: 'object'
  properties?: Record<string, unknown>
  required?: string[]
} {
  return tool.schema.toJSONSchema(tool.schema.object(definition.args)) as {
    type: 'object'
    properties?: Record<string, unknown>
    required?: string[]
  }
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
  for (const [name, definition] of Object.entries(ptyTools)) {
    const info: ToolInfoV2 = {
      name,
      description: describeForRoute(definition.description, 'opencode'),
      input: toolInputSchema(definition),
      execute: async (input, context) => {
        const result = await definition.execute(input as never, context as never)
        return typeof result === 'string' ? { content: result } : result
      },
    }
    add(info)
  }
}
