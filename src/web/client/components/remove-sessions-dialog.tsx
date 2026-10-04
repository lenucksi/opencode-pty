import { useCallback, useEffect, useRef } from 'react'

/**
 * What a bulk removal is about to do, counted before it happens.
 *
 * The two numbers are the point of this dialog. "Remove 205 sessions?" tells a
 * reader nothing about the one that was running; 204 of those are files moving
 * to the trash, and one is a process being stopped with its output discarded.
 * Both numbers are named so the choice is made with the consequence in view.
 */
export interface RemovalPlan {
  /** Finished sessions: their output moves to the trash and can be restored. */
  removable: number
  /** Running sessions: stopped, and their output is not recoverable. */
  stoppable: number
  /** How many selected sessions the current filter hides. */
  hiddenByFilter: number
}

interface RemoveSessionsDialogProps {
  open: boolean
  plan: RemovalPlan
  /** Label for the action, so the button says what it will do. */
  confirmLabel: string
  onConfirm: () => void
  onClose: () => void
}

/**
 * Confirmation for a bulk removal, on the native `<dialog>`.
 *
 * A native `confirm()` cannot name the running/torn-off split, and the repo's
 * own convention is `<dialog>` for modals, so this is the same top layer,
 * focus trap and ESC handling the settings dialog already uses.
 */
export function RemoveSessionsDialog({
  open,
  plan,
  confirmLabel,
  onConfirm,
  onClose,
}: RemoveSessionsDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) {
      dialog.showModal()
    } else if (!open && dialog.open) {
      dialog.close()
    }
  }, [open])

  // A click on the backdrop lands on the dialog element itself. Anything inside
  // the panel is a descendant, so the check is what distinguishes the two.
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const onClick = (event: MouseEvent) => {
      if (event.target === dialog) onClose()
    }
    dialog.addEventListener('click', onClick)
    return () => dialog.removeEventListener('click', onClick)
  }, [onClose])

  const total = plan.removable + plan.stoppable

  return (
    <dialog
      ref={dialogRef}
      className="remove-dialog"
      aria-labelledby="remove-dialog-title"
      data-testid="remove-sessions-dialog"
      onCancel={(event) => {
        // ESC closes the element natively; this keeps React's `open` in step so
        // the dialog cannot be reopened in a state the element disagrees with.
        event.preventDefault()
        onClose()
      }}
    >
      <div className="remove-dialog-panel">
        <h2 id="remove-dialog-title" className="remove-dialog-title">
          Remove {total} session{total === 1 ? '' : 's'}?
        </h2>

        <ul className="remove-dialog-list">
          {plan.removable > 0 ? (
            <li>
              <strong>{plan.removable}</strong> finished session
              {plan.removable === 1 ? '' : 's'} will be removed. Their output can be restored until
              the server restarts.
            </li>
          ) : null}
          {plan.stoppable > 0 ? (
            <li className="remove-dialog-warning">
              <strong>{plan.stoppable}</strong> running session{plan.stoppable === 1 ? '' : 's'}{' '}
              will be stopped. {plan.stoppable === 1 ? 'Its' : 'Their'} output is discarded and
              cannot be restored.
            </li>
          ) : null}
          {plan.hiddenByFilter > 0 ? (
            <li className="remove-dialog-hidden" data-testid="remove-dialog-hidden">
              {plan.hiddenByFilter} selected session
              {plan.hiddenByFilter === 1 ? ' is' : 's are'} hidden by the current search and will be
              removed anyway.
            </li>
          ) : null}
        </ul>

        <div className="remove-dialog-actions">
          <button type="button" className="remove-dialog-cancel" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="remove-dialog-confirm"
            onClick={onConfirm}
            data-testid="remove-dialog-confirm"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  )
}

interface UndoToastProps {
  /** How many sessions the removal actually took away. */
  count: number
  /** The ids that came back as restorable, which is not always every id asked for. */
  restorable: number
  onUndo: () => void
  onDismiss: () => void
}

const UNDO_WINDOW_MS = 10_000

/**
 * The undo affordance after a removal.
 *
 * The undo window is bounded by the server: the trash is emptied at startup, so
 * this toast says "until the server restarts" rather than pretending otherwise.
 * `restorable` is reported separately from `count` because a stopped session
 * leaves a record but not its output - offering Undo for it and then restoring
 * an empty row would be a worse lie than not offering it.
 */
export function UndoToast({ count, restorable, onUndo, onDismiss }: UndoToastProps) {
  const undoRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (count === 0) return
    undoRef.current?.focus()
    const timer = setTimeout(onDismiss, UNDO_WINDOW_MS)
    return () => clearTimeout(timer)
  }, [count, onDismiss])

  const handleUndo = useCallback(() => {
    onUndo()
    onDismiss()
  }, [onUndo, onDismiss])

  if (count === 0) return null

  return (
    <div className="undo-toast" role="status" data-testid="undo-toast">
      <span className="undo-toast-text">
        Removed {count} session{count === 1 ? '' : 's'}.
        {restorable > 0
          ? ` Output can be restored until the server restarts.`
          : ' No output could be kept.'}
      </span>
      {restorable > 0 ? (
        <button
          type="button"
          ref={undoRef}
          className="undo-toast-action"
          onClick={handleUndo}
          data-testid="undo-toast-action"
        >
          Undo
        </button>
      ) : null}
      <button
        type="button"
        className="undo-toast-dismiss"
        onClick={onDismiss}
        aria-label="Dismiss"
        data-testid="undo-toast-dismiss"
      >
        ×
      </button>
    </div>
  )
}
