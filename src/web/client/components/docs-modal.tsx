import { type RefObject, useCallback, useEffect, useRef, useState } from 'react'

import { api } from 'opencode-pty/web/shared/api-client'
import type { UsageDocsResponse } from 'opencode-pty/web/shared/usage-docs'

interface DocsModalProps {
  open: boolean
  onClose: () => void
  /** Element that regains focus when the dialog closes (the Docs button). */
  returnFocusRef?: RefObject<HTMLElement | null>
  /** App shell that is made `inert` while the dialog is open. */
  inertTarget?: RefObject<HTMLElement | null>
}

type DocsTab = 'humans' | 'llm'

/**
 * Usage documentation, split by audience.
 *
 * "For humans" is short orientation text. "For LLMs" is the skill document the
 * plugin hands to the agent, served verbatim from `/api/docs`, with a copy
 * button so it can be dropped into an `AGENTS.md` or a system prompt.
 *
 * Built on the native `<dialog>` element, like the settings dialog, for the top
 * layer, ESC handling and the focus trap.
 */
export function DocsModal({ open, onClose, returnFocusRef, inertTarget }: DocsModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [tab, setTab] = useState<DocsTab>('humans')
  const [docs, setDocs] = useState<UsageDocsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  // Read at event time: the native `close` event also fires when we close the
  // dialog ourselves, and only a user-initiated close should notify the parent.
  const openRef = useRef(open)
  openRef.current = open
  const wasOpenRef = useRef(false)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) {
      dialog.showModal()
    } else if (!open && dialog.open) {
      dialog.close()
    }
  }, [open])

  useEffect(() => {
    const target = inertTarget?.current
    if (!target) return
    if (open) {
      target.setAttribute('inert', '')
    } else {
      target.removeAttribute('inert')
    }
    return () => target.removeAttribute('inert')
  }, [open, inertTarget])

  useEffect(() => {
    if (open) {
      wasOpenRef.current = true
      return
    }
    if (!wasOpenRef.current) return
    wasOpenRef.current = false
    returnFocusRef?.current?.focus()
  }, [open, returnFocusRef])

  // Fetch lazily on first open; the document never changes while the server runs.
  useEffect(() => {
    if (!open || docs || error) return
    let cancelled = false
    setError(null)
    api
      .docs()
      .then((response) => {
        if (!cancelled) setDocs(response)
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      cancelled = true
    }
  }, [open, docs, error])

  const handleNativeClose = useCallback(() => {
    if (openRef.current) onClose()
  }, [onClose])

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const onClick = (event: MouseEvent) => {
      if (event.target === dialog) onClose()
    }
    dialog.addEventListener('click', onClick)
    return () => dialog.removeEventListener('click', onClick)
  }, [onClose])

  const handleCopy = useCallback(() => {
    if (!docs) return
    const markdown = [
      `# ${docs.llm.name}`,
      '',
      `> Skill: \`${docs.llm.location}\``,
      '',
      docs.llm.content,
    ].join('\n')
    navigator.clipboard
      ?.writeText(markdown)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1600)
      })
      .catch(() => setError('Clipboard is not available in this browser'))
  }, [docs])

  return (
    <dialog
      ref={dialogRef}
      className="docs-dialog"
      aria-labelledby="docs-dialog-title"
      onClose={handleNativeClose}
    >
      <div className="docs-panel">
        <header className="docs-panel-header">
          <h2 id="docs-dialog-title" className="docs-title">
            Documentation
          </h2>
          <button
            type="button"
            className="docs-close"
            onClick={onClose}
            aria-label="Close documentation"
          >
            ×
          </button>
        </header>

        <div className="docs-tabs" role="tablist" aria-label="Documentation audience">
          <button
            type="button"
            role="tab"
            id="docs-tab-humans"
            aria-selected={tab === 'humans'}
            aria-controls="docs-panel-humans"
            className="docs-tab"
            onClick={() => setTab('humans')}
          >
            For humans
          </button>
          <button
            type="button"
            role="tab"
            id="docs-tab-llm"
            aria-selected={tab === 'llm'}
            aria-controls="docs-panel-llm"
            className="docs-tab"
            onClick={() => setTab('llm')}
          >
            For LLMs
          </button>
        </div>

        <div className="docs-body">
          {error ? (
            <p className="docs-error" role="alert">
              {error}
            </p>
          ) : !docs ? (
            <p className="docs-loading">Loading documentation…</p>
          ) : tab === 'humans' ? (
            <div
              id="docs-panel-humans"
              role="tabpanel"
              aria-labelledby="docs-tab-humans"
              className="docs-sections"
            >
              {docs.sections.map((section) => (
                <section key={section.id} className="docs-section">
                  <h3 className="docs-section-title">{section.title}</h3>
                  {section.body?.map((paragraph) => (
                    <p key={paragraph} className="docs-paragraph">
                      {paragraph}
                    </p>
                  ))}
                  {section.list ? (
                    <ul className="docs-list">
                      {section.list.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  ) : null}
                </section>
              ))}
              <p className="docs-footer">
                <a href={docs.readmeUrl} target="_blank" rel="noreferrer">
                  Full documentation on GitHub
                </a>
              </p>
            </div>
          ) : (
            <div
              id="docs-panel-llm"
              role="tabpanel"
              aria-labelledby="docs-tab-llm"
              className="docs-llm"
            >
              <p className="docs-llm-intro">
                This is the exact skill document the plugin hands to the agent (
                <code>{docs.llm.location}</code>). Copy it into an <code>AGENTS.md</code> or a
                system prompt to reuse the guidance.
              </p>
              <div className="docs-llm-toolbar">
                <button type="button" className="docs-copy" onClick={handleCopy}>
                  {copied ? 'Copied' : 'Copy as Markdown'}
                </button>
              </div>
              <pre className="docs-pre">
                <code>{docs.llm.content}</code>
              </pre>
            </div>
          )}
        </div>
      </div>
    </dialog>
  )
}
