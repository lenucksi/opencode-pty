import { useEffect, useRef } from 'react'

interface DownloadMenuProps {
  sessionId: string
}

const OPTIONS = [
  {
    format: 'plain',
    label: 'Text (.txt)',
    hint: 'Readable text: control characters removed',
  },
  {
    format: 'raw',
    label: 'Raw with control characters (.log)',
    hint: 'Exactly what the process emitted, escape sequences included',
  },
] as const

/**
 * Download the session transcript.
 *
 * A native `<details>` keeps this dependency-free and keyboard reachable. There
 * are two formats because a transcript has two audiences: people want readable
 * text, tools (and colour debugging) want every escape sequence.
 */
export function DownloadMenu({ sessionId }: DownloadMenuProps) {
  const detailsRef = useRef<HTMLDetailsElement>(null)

  useEffect(() => {
    const close = () => detailsRef.current?.removeAttribute('open')

    const onPointerDown = (event: PointerEvent) => {
      const details = detailsRef.current
      if (!details?.open) return
      if (event.target instanceof Node && !details.contains(event.target)) close()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }

    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  return (
    <details className="download-menu" ref={detailsRef}>
      <summary className="copy-btn download-menu-toggle" title="Download this session's output">
        Download
      </summary>
      <div className="download-menu-items">
        {OPTIONS.map((option) => (
          <a
            key={option.format}
            className="download-menu-item"
            href={`/api/sessions/${sessionId}/log?format=${option.format}&download=1`}
            title={option.hint}
            onClick={() => detailsRef.current?.removeAttribute('open')}
          >
            {option.label}
          </a>
        ))}
      </div>
    </details>
  )
}
