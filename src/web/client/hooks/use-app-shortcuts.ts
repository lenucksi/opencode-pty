import { useEffect } from 'react'

interface AppShortcutOptions {
  /** Ctrl+Shift+C, and Cmd+C where that is the platform convention. */
  onCopy: () => void | Promise<void>
  onOpenSettings: () => void
  onOpenDocs: () => void
  /** The settings dialog wins ties, so a stray slash does not stack a second dialog. */
  settingsOpen: boolean
}

/**
 * The global keybindings.
 *
 * All three listen in the capture phase so they still fire while the terminal
 * canvas has focus. Plain Ctrl+C is deliberately untouched: it has to keep
 * reaching the process as SIGINT.
 */
export function useAppShortcuts({
  onCopy,
  onOpenSettings,
  onOpenDocs,
  settingsOpen,
}: AppShortcutOptions): void {
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.code !== 'KeyC' || !(event.metaKey || (event.ctrlKey && event.shiftKey))) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      void onCopy()
    }
    document.addEventListener('keydown', listener, { capture: true })
    return () => document.removeEventListener('keydown', listener, { capture: true })
  }, [onCopy])

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key !== ',' || !(event.metaKey || event.ctrlKey)) {
        return
      }
      event.preventDefault()
      onOpenSettings()
    }
    document.addEventListener('keydown', listener, { capture: true })
    return () => document.removeEventListener('keydown', listener, { capture: true })
  }, [onOpenSettings])

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key !== '/' || !(event.metaKey || event.ctrlKey) || settingsOpen) {
        return
      }
      event.preventDefault()
      onOpenDocs()
    }
    document.addEventListener('keydown', listener, { capture: true })
    return () => document.removeEventListener('keydown', listener, { capture: true })
  }, [onOpenDocs, settingsOpen])
}
