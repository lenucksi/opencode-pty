import { PTY_USAGE_SKILL } from '../../../v2/skill.ts'
import { HUMAN_USAGE_DOCS, README_URL, type UsageDocsResponse } from '../../shared/usage-docs.ts'
import { JsonResponse } from './responses.ts'

/**
 * Usage documentation for the docs dialog.
 *
 * The LLM half is served straight from `PTY_USAGE_SKILL`, the same constant the
 * plugin registers with the host. Reading one source is what keeps the dialog
 * and the agent's instructions from drifting apart.
 */
export function handleUsageDocs(): JsonResponse {
  const payload: UsageDocsResponse = {
    readmeUrl: README_URL,
    sections: [...HUMAN_USAGE_DOCS],
    llm: {
      name: PTY_USAGE_SKILL.name,
      description: PTY_USAGE_SKILL.description ?? '',
      location: PTY_USAGE_SKILL.location,
      content: PTY_USAGE_SKILL.content,
    },
  }
  return new JsonResponse(payload)
}
