/** Minimal clipboard surface, so the fallback logic is testable without a browser. */
export interface ClipboardWriter {
  writeText(text: string): Promise<void>
}

/** Legacy synchronous copy, used when the async clipboard API is unavailable. */
export type LegacyCopy = (text: string) => boolean

export interface ClipboardEnvironment {
  clipboard?: ClipboardWriter | null
  legacyCopy?: LegacyCopy
}

function browserClipboard(): ClipboardWriter | null {
  if (typeof navigator === 'undefined') return null
  return navigator.clipboard ?? null
}

/**
 * Put `text` on the clipboard.
 *
 * The async clipboard API needs a secure context, so a UI served over plain
 * HTTP from a LAN address does not have it at all; the legacy
 * `execCommand('copy')` path still works there, which is why both are tried.
 */
export async function copyTextToClipboard(
  text: string,
  environment: ClipboardEnvironment = {}
): Promise<boolean> {
  if (!text) return false

  const clipboard = environment.clipboard !== undefined ? environment.clipboard : browserClipboard()

  if (clipboard) {
    try {
      await clipboard.writeText(text)
      return true
    } catch {
      // Permission denied, insecure context or a detached document: fall through
      // to the legacy path instead of reporting a copy that never happened.
    }
  }

  const legacyCopy = environment.legacyCopy ?? copyWithExecCommand
  return legacyCopy(text)
}

/** Hidden-textarea copy for contexts without the async clipboard API. */
function copyWithExecCommand(text: string): boolean {
  if (typeof document === 'undefined') return false

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.top = '-1000px'
  textarea.style.opacity = '0'

  document.body.appendChild(textarea)
  try {
    textarea.select()
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    textarea.remove()
  }
}
