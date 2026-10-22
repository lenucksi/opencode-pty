/**
 * The MCP server: the PTY tools over stdio, without OpenCode.
 *
 * The handlers are the existing ones - the same modules the plugin registers - and
 * the daemon is what they talk to. The MCP layer is a dispatcher and a startup
 * hook, not a rewrite: the text a model reads here and the text the plugin's model
 * reads are the same, because it is the same code.
 *
 * Two things are the route's own:
 *
 * - **Who may call what.** A foreign harness has no host to ask, so the policy is
 *   the gate: the rules of the machine, read from the configuration, and a command
 *   nobody allowed is refused. The default is to refuse, because here the user has
 *   not said yes to anything yet.
 * - **Which conversation a session belongs to.** MCP has no session id, so the
 *   server names itself: `mcp-<pid>` groups the sessions of one server in the web
 *   interface, and makes them collectable.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

import { ptyTools, type PTYToolName } from '../plugin/pty/tools/all.ts'
import { describeForRoute } from '../plugin/pty/tools/description.ts'
import { toolInputSchema } from '../v2/tools.ts'
import { PTY_USAGE_SKILL } from '../v2/skill.ts'

/** The conversation the sessions of this server belong to. */
export function serverSessionId(): string {
  return `mcp-${process.pid}`
}

/**
 * The context the tools see.
 *
 * The tools were written against the plugin's context, and they read two things
 * from it: the session a session belongs to and the agent that asked. Here the
 * session is the server's own name and the agent is the route's. The progress
 * token is the route's third thing: it belongs to the request, and a wait needs
 * it to say that it is still running.
 */
export function serverContext(progressToken?: string | number): {
  sessionID: string
  agent: string
  messageID: string
  abort: AbortSignal
  metadata: () => void
  ask: () => Promise<void>
  directory: string
  worktree: string
  progressToken?: string | number
} {
  return {
    sessionID: serverSessionId(),
    agent: 'mcp',
    messageID: `mcp-${process.pid}-0`,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
    directory: process.cwd(),
    worktree: process.cwd(),
    ...(progressToken === undefined ? {} : { progressToken }),
  }
}

/**
 * The tool list, as MCP describes it.
 *
 * The names, the descriptions and the schemas are the plugin's - the same modules,
 * the same text. A harness that asks what `pty_spawn` takes gets the answer the
 * plugin's model gets.
 */
export function toolList(): {
  name: string
  description: string
  inputSchema: { type: 'object'; properties?: Record<string, unknown>; required?: string[] }
}[] {
  return Object.entries(ptyTools).map(([name, definition]) => ({
    name,
    description: describeForRoute(definition.description, 'mcp'),
    inputSchema: toolInputSchema(definition),
  }))
}

/**
 * The server, with the PTY tools registered.
 *
 * The low-level server rather than the convenience one, because the JSON Schema
 * of the arguments is ours: the tools carry a zod shape, and the schema a harness
 * validates against is the one this plugin produces.
 */
export function createMcpServer(): Server {
  const server = new Server(
    {
      name: 'opencode-pty',
      version: '1.0.0',
    },
    { capabilities: { tools: {}, prompts: {} } }
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolList() }))

  // The usage guide, as a prompt. The OpenCode route offers it as a skill; here
  // it is a prompt, and it is this route's text - the guide tells a model how to
  // wait for an exit, and this route has no exit message to wait for.
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
      {
        name: PTY_USAGE_SKILL.name,
        description: PTY_USAGE_SKILL.description,
      },
    ],
  }))
  server.setRequestHandler(GetPromptRequestSchema, async () => ({
    description: PTY_USAGE_SKILL.description,
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: describeForRoute(PTY_USAGE_SKILL.content, 'mcp'),
        },
      },
    ],
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name
    const definition = ptyTools[name as PTYToolName]
    if (definition === undefined) {
      return {
        isError: true,
        content: [{ type: 'text', text: `unknown tool: ${name}` }],
      }
    }
    // The progress token of this call: a wait that says nothing is a wait the
    // transport may cut, and a cut says nothing about the session.
    const progressToken = request.params._meta?.progressToken
    try {
      const result = await definition.execute(
        request.params.arguments as never,
        serverContext(progressToken) as never
      )
      return { content: [{ type: 'text', text: result }] }
    } catch (error) {
      // The failure is the answer, not a crash: a harness shows the text, and the
      // text is what the plugin's own tools return.
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: error instanceof Error ? error.message : String(error),
          },
        ],
      }
    }
  })

  return server
}
