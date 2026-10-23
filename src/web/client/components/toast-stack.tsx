import type { Toast } from '../hooks/use-toasts.ts'

interface ToastStackProps {
  toasts: readonly Toast[]
  onDismiss: (id: number) => void
}

/**
 * The corner where the plugin tells the reader what it did.
 *
 * Bottom-right, opposite the undo bar: the two can be on screen at the same time,
 * and a removal's undo is the one with a deadline - it must not be pushed aside by
 * a notice about something else.
 *
 * **Pointer events are off on purpose.** The stack sits over the terminal, and a
 * card that captured the mouse would swallow the drag that selects text or the
 * click that focuses the terminal. Only the close button is interactive, which is
 * the one part that has to be.
 */
export function ToastStack({ toasts, onDismiss }: ToastStackProps) {
  if (toasts.length === 0) return null

  return (
    <div className="toast-stack" data-testid="toast-stack">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`toast toast-${toast.variant}`}
          data-testid="toast"
          // An error is announced at once; everything else waits for a pause in the
          // page's own announcements, because none of it is urgent.
          role={toast.variant === 'error' ? 'alert' : 'status'}
          aria-live={toast.variant === 'error' ? 'assertive' : 'polite'}
        >
          <span className="toast-message">{toast.message}</span>
          <button
            type="button"
            className="toast-close"
            onClick={() => onDismiss(toast.id)}
            aria-label="Dismiss notification"
            title="Dismiss"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
