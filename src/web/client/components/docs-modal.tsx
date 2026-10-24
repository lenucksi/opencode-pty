import { api } from '../../shared/api-client.ts'
import type { LicensesResponse } from '../../shared/licenses.ts'
import type { UsageDocsResponse } from '../../shared/usage-docs.ts'
import { type RefObject, useCallback, useEffect, useState } from 'react'
import { useDialog } from '../hooks/use-dialog.ts'

interface DocsModalProps {
  open: boolean
  onClose: () => void
  /** Element that regains focus when the dialog closes (the Docs button). */
  returnFocusRef?: RefObject<HTMLElement | null>
  /** App shell that is made `inert` while the dialog is open. */
  inertTarget?: RefObject<HTMLElement | null>
}

type DocsTab = 'humans' | 'llm' | 'licenses'

/** One row per tab: the id doubles as the element ids, so they cannot drift. */
const DOCS_TABS: readonly { id: DocsTab; label: string }[] = [
  { id: 'humans', label: 'For humans' },
  { id: 'llm', label: 'For LLMs' },
  { id: 'licenses', label: 'Licences' },
]

/**
 * One request per resource, made on first use.
 *
 * Both tabs that fetch have the same rules: ask once, keep the answer for the
 * life of the dialog, and turn a rejection into a message instead of retrying on
 * every render. `enabled` is what makes the licences request wait for its tab.
 */
function useLazyJson<T>(enabled: boolean, load: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // A settled answer is not asked for again; the guard is also what keeps a
    // failed request from looping.
    if (!enabled || data !== null || error !== null) return
    let cancelled = false
    load()
      .then((value) => {
        if (!cancelled) setData(value)
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      cancelled = true
    }
  }, [enabled, data, error, load])

  return { data, error }
}

/**
 * Usage documentation and third-party notices, split by audience.
 *
 * "For humans" is short orientation text. "For LLMs" is the skill document the
 * plugin hands to the agent, served verbatim from `/api/docs`, with a copy
 * button so it can be dropped into an `AGENTS.md` or a system prompt.
 * "Licences" is the generated notice list plus four hand-written credits lines;
 * its data comes from `/api/licenses`, never from this file.
 *
 * Built on the native `<dialog>` element, like the settings dialog, for the top
 * layer, ESC handling and the focus trap.
 */
export function DocsModal({ open, onClose, returnFocusRef, inertTarget }: DocsModalProps) {
  const { dialogRef, handleNativeClose } = useDialog({ open, onClose, returnFocusRef, inertTarget })
  const [tab, setTab] = useState<DocsTab>('humans')
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState<string | null>(null)

  // The documents never change while the server runs, and most visits never
  // leave the first tab, so the notices wait for their tab.
  const loadDocs = useCallback(() => api.docs(), [])
  const loadLicenses = useCallback(() => api.licenses(), [])
  const { data: docs, error: docsError } = useLazyJson(open, loadDocs)
  const { data: licenses, error: licensesError } = useLazyJson(
    open && tab === 'licenses',
    loadLicenses
  )

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
      .catch(() => setCopyError('Clipboard is not available in this browser'))
  }, [docs])

  const docsFailure = docsError ?? copyError

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
          {DOCS_TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              id={`docs-tab-${entry.id}`}
              aria-selected={tab === entry.id}
              aria-controls={`docs-panel-${entry.id}`}
              className="docs-tab"
              onClick={() => setTab(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>

        <div className="docs-body">
          {tab === 'licenses' ? (
            licensesError ? (
              <p className="docs-error" role="alert">
                {licensesError}
              </p>
            ) : licenses ? (
              <LicensesPanel data={licenses} />
            ) : (
              <p className="docs-loading">Loading licences…</p>
            )
          ) : docsFailure ? (
            <p className="docs-error" role="alert">
              {docsFailure}
            </p>
          ) : !docs ? (
            <p className="docs-loading">Loading documentation…</p>
          ) : tab === 'humans' ? (
            <HumansPanel docs={docs} />
          ) : (
            <LlmPanel docs={docs} copied={copied} onCopy={handleCopy} />
          )}
        </div>
      </div>
    </dialog>
  )
}

function HumansPanel({ docs }: { docs: UsageDocsResponse }) {
  return (
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
  )
}

function LlmPanel({
  docs,
  copied,
  onCopy,
}: {
  docs: UsageDocsResponse
  copied: boolean
  onCopy: () => void
}) {
  return (
    <div id="docs-panel-llm" role="tabpanel" aria-labelledby="docs-tab-llm" className="docs-llm">
      <p className="docs-llm-intro">
        This is the exact skill document the plugin hands to the agent (
        <code>{docs.llm.location}</code>). Copy it into an <code>AGENTS.md</code> or a system prompt
        to reuse the guidance.
      </p>
      <div className="docs-llm-toolbar">
        <button type="button" className="docs-copy" onClick={onCopy}>
          {copied ? 'Copied' : 'Copy as Markdown'}
        </button>
      </div>
      <pre className="docs-pre">
        <code>{docs.llm.content}</code>
      </pre>
    </div>
  )
}

/**
 * The notice list: credits first, then one collapsible group per licence.
 *
 * Collapsed by default, because the point of this tab is the answer to "what am
 * I running, and under what licence" - thirteen group lines, not a 450-row wall.
 * Opening a group shows its packages; the count on the summary stays visible, so
 * a reader can stop without opening anything.
 */
function LicensesPanel({ data }: { data: LicensesResponse }) {
  return (
    <div
      id="docs-panel-licenses"
      role="tabpanel"
      aria-labelledby="docs-tab-licenses"
      className="docs-licenses"
    >
      <section className="docs-credits">
        <h3 className="docs-section-title">Credits</h3>
        <ul className="docs-credit-list">
          {data.credits.map((credit) => (
            <li key={credit.name} className="docs-credit">
              <a href={credit.url} target="_blank" rel="noreferrer">
                {credit.name}
              </a>
              <span className="docs-credit-license">{credit.license}</span>
              <span className="docs-credit-note">{credit.note}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="docs-license-section">
        <h3 className="docs-section-title">Third-party packages</h3>
        {data.available ? (
          <>
            <p className="docs-paragraph">
              {data.total} installed packages under {data.groups.length} licences, generated from
              the lockfile at build time. Open a licence to see its packages.
            </p>
            <div className="docs-license-groups">
              {data.groups.map((group) => (
                <details
                  key={group.license}
                  className="docs-license-group"
                  data-license={group.license}
                >
                  <summary className="docs-license-summary">
                    <span className="docs-license-name">{group.license}</span>
                    <span className="docs-license-count">
                      {group.count} {group.count === 1 ? 'package' : 'packages'}
                    </span>
                  </summary>
                  <ul className="docs-license-packages">
                    {group.packages.map((pkg) => (
                      <li key={`${pkg.name}@${pkg.version}`} className="docs-license-package">
                        {pkg.name}@{pkg.version}
                      </li>
                    ))}
                  </ul>
                </details>
              ))}
            </div>
          </>
        ) : (
          <p className="docs-paragraph">
            This build has no licence artifact. Run the production build to generate it.
          </p>
        )}
      </section>
    </div>
  )
}
