import type { PTYSessionInfo } from './types.ts'

export function formatSessionInfo(session: PTYSessionInfo): string[] {
  const timedOutInfo = session.timedOut ? ' | timed out' : ''
  const exitInfo = session.exitCode !== undefined ? ` | exit: ${session.exitCode}` : ''
  const exitSignal = session.exitSignal ? ` | signal: ${session.exitSignal}` : ''
  const timeoutInfo =
    session.timeoutSeconds !== undefined ? ` | timeout: ${session.timeoutSeconds}s` : ''
  return [
    `[${session.id}] ${session.title}`,
    `  Command: ${session.command} ${session.args.join(' ')}`,
    `  Status: ${session.status}${timedOutInfo}${exitInfo}${exitSignal}`,
    `  PID: ${session.pid}${timeoutInfo}`,
    `  Lines: ${session.lineCount}`,
    `  Workdir: ${session.workdir}`,
    `  Created: ${session.createdAt}`,
    '',
  ]
}

export function formatPtyOutputBlock(
  id: string,
  status: string,
  lines: string[],
  pattern?: string
): string {
  const patternAttr = pattern ? ` pattern="${pattern}"` : ''
  return [
    `<pty_output id="${id}" status="${status}"${patternAttr}>`,
    ...lines,
    `</pty_output>`,
  ].join('\n')
}

export function formatLine(line: string, lineNum: number, maxLength: number = 2000): string {
  const lineNumStr = lineNum.toString().padStart(5, '0')
  const truncatedLine = line.length > maxLength ? `${line.slice(0, maxLength)}...` : line
  return `${lineNumStr}| ${truncatedLine}`
}
