import { type RefObject, useCallback, useEffect, useRef } from 'react'

interface UseDialogOptions {
  open: boolean
  /** Called for a user-initiated close only: backdrop click, ESC, native close. */
  onClose: () => void
  /** Element that regains focus once the dialog closes. */
  returnFocusRef?: RefObject<HTMLElement | null>
  /** App shell that is made `inert` while the dialog is open. */
  inertTarget?: RefObject<HTMLElement | null>
}

/**
 * The mechanics every `<dialog>` in this app needs.
 *
 * `showModal()` gives the top layer, ESC-to-close and the focus trap; what is
 * left is keeping the React-controlled `open` in step with the element, making
 * the background inert, and telling a user-initiated close apart from the one we
 * caused ourselves. That last part is the whole reason `openRef` exists: the
 * native `close` event fires for both.
 *
 * Extracted because three components had this block copied into them, and a fix
 * to the focus handling would otherwise have had to be made three times.
 */
export function useDialog({ open, onClose, returnFocusRef, inertTarget }: UseDialogOptions) {
  const dialogRef = useRef<HTMLDialogElement>(null)

  // Read at event time, and synced in an effect: the only reader is an event
  // handler, which cannot run before the effect for the same render has.
  const openRef = useRef(open)
  useEffect(() => {
    openRef.current = open
  }, [open])
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

  // `showModal()` already makes the rest of the document inert, but setting the
  // attribute explicitly documents the intent and keeps the app shell out of the
  // tab order on browsers with a partial top-layer implementation.
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

  // Focus returns to the trigger once the background is interactive again. The
  // effect order matters: the inert attribute is removed above before this runs.
  useEffect(() => {
    if (open) {
      wasOpenRef.current = true
      return
    }
    if (!wasOpenRef.current) return
    wasOpenRef.current = false
    returnFocusRef?.current?.focus()
  }, [open, returnFocusRef])

  /** A click on the backdrop lands on the dialog element itself. */
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const onClick = (event: MouseEvent) => {
      if (event.target === dialog) onClose()
    }
    dialog.addEventListener('click', onClick)
    return () => dialog.removeEventListener('click', onClick)
  }, [onClose])

  const handleNativeClose = useCallback(() => {
    if (openRef.current) onClose()
  }, [onClose])

  return { dialogRef, handleNativeClose }
}
