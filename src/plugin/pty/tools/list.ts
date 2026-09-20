import { tool } from '@opencode-ai/plugin'
import { manager } from '../manager.ts'
import { formatSessionInfo } from '../formatters.ts'
import DESCRIPTION from './list.txt'

export const ptyList = tool({
  description: DESCRIPTION,
  args: {},
  async execute() {
    const sessions = manager.list()
    const server = manager.describeServer()

    if (sessions.length === 0) {
      return [
        '<pty_list>',
        `Generation: ${server.generation}`,
        'No active PTY sessions.',
        '</pty_list>',
      ].join('\n')
    }

    const lines = [
      '<pty_list>',
      `Generation: ${server.generation} | ${server.running} running, ${
        server.sessions - server.running
      } finished${server.archived > 0 ? `, ${server.archived} archived` : ''}`,
    ]
    for (const session of sessions) {
      lines.push(...formatSessionInfo(session))
    }
    lines.push(`Total: ${sessions.length} session(s)`)
    lines.push('</pty_list>')

    return lines.join('\n')
  },
})
