import type { NoticeVariant } from '../../../shared/notice.ts'
import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * The toasts, and the timer that takes each one away.
 *
 * One list with one timer per toast, because they are independent: a notice from
 * the server and a failed click can be on screen at the same time, and the one that
 * arrived first must not take the other with it. Errors stay longer than the rest,
 * since they are the ones a reader has to act on.
 */

export interface Toast {
  readonly id: number
  readonly message: string
  readonly variant: NoticeVariant
}

/** How long a toast stays, by how much it asks of the reader. */
const LIFETIME_MS: Record<NoticeVariant, number> = {
  info: 6000,
  success: 6000,
  warning: 8000,
  // An error is the one a reader may have to copy or act on, so it waits.
  error: 12000,
}

export function useToasts() {
  const [toasts, setToasts] = useState<readonly Toast[]>([])
  const nextIdRef = useRef(1)
  /** One timer per toast, so dismissing one cannot cancel another's. */
  const timersRef = useRef(new Map<number, ReturnType<typeof setTimeout>>())

  const dismiss = useCallback((id: number) => {
    const timer = timersRef.current.get(id)
    if (timer !== undefined) {
      clearTimeout(timer)
      timersRef.current.delete(id)
    }
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  const show = useCallback(
    (message: string, variant: NoticeVariant = 'info') => {
      if (message === '') return
      const id = nextIdRef.current
      nextIdRef.current += 1
      setToasts((current) => [...current, { id, message, variant }])
      timersRef.current.set(
        id,
        setTimeout(() => dismiss(id), LIFETIME_MS[variant])
      )
    },
    [dismiss]
  )

  // Every timer belongs to this component: one left running past unmount would try
  // to set state on a component that is gone.
  useEffect(() => {
    const timers = timersRef.current
    return () => {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    }
  }, [])

  return { toasts, show, dismiss }
}
