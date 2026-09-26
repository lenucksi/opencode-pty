import { MAX_LINE_LENGTH } from '../../shared/constants.ts'

/** Canonical documentation for the humans who read the Web UI. */
export interface UsageDocSection {
  id: string
  title: string
  body?: string[]
  list?: string[]
}

/** The LLM-facing guide, served verbatim so both audiences read one source. */
export interface UsageDocsLlm {
  name: string
  description: string
  location: string
  content: string
}

export interface UsageDocsResponse {
  readmeUrl: string
  sections: UsageDocSection[]
  llm: UsageDocsLlm
}

export const README_URL = 'https://github.com/lenucksi/opencode-pty#readme'

/**
 * Human-facing notes for the docs dialog.
 *
 * Deliberately shorter than the README: this is a quick orientation inside the
 * running app, and `readmeUrl` points at the long form.
 */
export const HUMAN_USAGE_DOCS: readonly UsageDocSection[] = [
  {
    id: 'what',
    title: 'What this page shows',
    body: [
      'Every background process the coding agent started on your behalf, one PTY session each.',
      'A session lives until it is killed. Its output is kept, so you can always read back what happened after the process is gone.',
    ],
  },
  {
    id: 'reading',
    title: 'Reading output',
    body: [
      'Click a session in the sidebar to attach it. Output streams in live over a WebSocket.',
      'Scrollback is preserved, and the Download menu saves the visible buffer or a range of it to a file.',
    ],
  },
  {
    id: 'sending-input',
    title: 'Sending input',
    body: [
      'Type in the terminal pane to send keystrokes to the process. This is what makes REPLs, prompts and TUIs work.',
      'Mouse selection and copy work even while an application has captured the mouse; hold Shift to select text in that case.',
    ],
  },
  {
    id: 'groups',
    title: 'Session groups',
    body: [
      'Sessions are grouped by the OpenCode conversation that requested them, so you can see at a glance which task a process belongs to.',
      'Each group shows the parent title, the agent that ran, and how many sessions it holds.',
    ],
  },
  {
    id: 'lifecycle',
    title: 'Running and finished',
    body: [
      'Running and finished sessions are listed separately. Finished sessions keep their output until you discard them.',
      'Clear finished removes them from the list when you no longer need them. Killing stops a process but keeps its buffer.',
      'Sessions are cleaned up automatically when the OpenCode conversation that created them ends.',
    ],
  },
  {
    id: 'terminal',
    title: 'Terminal fidelity',
    body: [
      'The terminal answers OSC 10 and 11 colour queries, so prompts and themes report their real colours.',
      'Light and dark themes follow your system preference; you can pin either one. Font size and the debug bar are in Settings.',
    ],
  },
  {
    id: 'agent',
    title: 'What the agent does',
    body: [
      'The agent drives these sessions through its own tools; this page is yours to watch and to clean up.',
      'The LLM tab shows the exact instructions handed to the agent, in case you want to review or reuse them.',
    ],
  },
  {
    id: 'limits',
    title: 'Good to know',
    list: [
      `A single output line is truncated at ${MAX_LINE_LENGTH} characters in the download and in the agent's view.`,
      'The Web UI binds an operating-system-assigned port unless a fixed one was configured, so it never blocks your dev server.',
      'The connection indicator in the sidebar shows whether live updates are flowing.',
    ],
  },
]
