import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react'

/**
 * Drag-and-drop of files onto a region, with the three things a naive
 * implementation gets wrong.
 *
 * 1. `dragleave` fires every time the pointer crosses into a *child*, so the
 *    obvious `onDragLeave={() => setOver(false)}` makes the highlight strobe
 *    over any non-trivial layout, and leaves it stuck on when the pointer
 *    exits via a child. Depth counting is the fix: enter increments, leave
 *    decrements, and only zero means gone.
 *
 * 2. Dragging selected text or a link also raises drag events. Without a
 *    check for actual files, highlighting a message and dragging it lights up
 *    a drop target that will do nothing when released.
 *
 * 3. Only the first file gets used. Dropping four photos into a channel and
 *    watching one arrive is worse than being told the limit.
 */

/** True when a drag is carrying files rather than text or a link. */
export function dragHasFiles(event: DragEvent): boolean {
  const transfer = event.dataTransfer
  if (!transfer) return false
  // `types` is the only thing populated during dragover — `files` is empty
  // until the drop itself, so checking it here always says no.
  return Array.from(transfer.types).includes('Files')
}

export interface FileDrop {
  /** True while a file drag is over the region; drive the drop styling off it. */
  over: boolean
  /** Spread onto the element that should accept files. */
  handlers: {
    onDragEnter: (e: DragEvent) => void
    onDragOver: (e: DragEvent) => void
    onDragLeave: (e: DragEvent) => void
    onDrop: (e: DragEvent) => void
  }
}

export interface FileDropOptions {
  /** Ignore the drop entirely — a read-only sheet, an upload in flight. */
  disabled?: boolean
  /**
   * Accept only some files. Runs per file; rejected ones are dropped
   * silently unless `onReject` says otherwise.
   */
  accept?: (file: File) => boolean
  /** Told about files that failed `accept`, so the UI can say why. */
  onReject?: (files: File[]) => void
}

/**
 * @param onFiles receives every accepted file, in the order they were dropped.
 */
export function useFileDrop(
  onFiles: (files: File[]) => void,
  { disabled = false, accept, onReject }: FileDropOptions = {}
): FileDrop {
  const [over, setOver] = useState(false)
  // A ref, not state: enter/leave pairs arrive faster than React re-renders,
  // and a stale closure over a count would lose track of the depth.
  const depth = useRef(0)

  // A drag that ends outside the window (or is cancelled with Escape) never
  // sends a leave to the region, so without this the highlight stays lit.
  useEffect(() => {
    const reset = () => {
      depth.current = 0
      setOver(false)
    }
    window.addEventListener('dragend', reset)
    window.addEventListener('drop', reset)
    return () => {
      window.removeEventListener('dragend', reset)
      window.removeEventListener('drop', reset)
    }
  }, [])

  const onDragEnter = useCallback(
    (e: DragEvent) => {
      if (disabled || !dragHasFiles(e)) return
      e.preventDefault()
      depth.current += 1
      setOver(true)
    },
    [disabled]
  )

  const onDragOver = useCallback(
    (e: DragEvent) => {
      if (disabled || !dragHasFiles(e)) return
      // Without preventDefault on *every* dragover the drop never fires, and
      // the browser navigates to the file instead — losing the app.
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    },
    [disabled]
  )

  const onDragLeave = useCallback(
    (e: DragEvent) => {
      if (disabled || !dragHasFiles(e)) return
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setOver(false)
    },
    [disabled]
  )

  const onDrop = useCallback(
    (e: DragEvent) => {
      if (disabled || !dragHasFiles(e)) return
      e.preventDefault()
      depth.current = 0
      setOver(false)
      const dropped = Array.from(e.dataTransfer?.files ?? [])
      if (dropped.length === 0) return
      const ok = accept ? dropped.filter(accept) : dropped
      const bad = accept ? dropped.filter((f) => !accept(f)) : []
      if (bad.length > 0) onReject?.(bad)
      if (ok.length > 0) onFiles(ok)
    },
    [disabled, accept, onReject, onFiles]
  )

  return { over, handlers: { onDragEnter, onDragOver, onDragLeave, onDrop } }
}

/**
 * Stop a file dropped anywhere else from navigating the window to it.
 *
 * The browser's default for an unhandled drop is to *open* the file, which
 * throws away the running app — mid-shift, with unsent messages in the
 * outbox. Missing a drop target should do nothing at all, not that.
 *
 * Call once, from the app root.
 */
export function guardStrayFileDrops(): () => void {
  const swallow = (e: Event) => {
    const drag = e as unknown as DragEvent
    if (!drag.dataTransfer) return
    if (!Array.from(drag.dataTransfer.types).includes('Files')) return
    e.preventDefault()
  }
  window.addEventListener('dragover', swallow)
  window.addEventListener('drop', swallow)
  return () => {
    window.removeEventListener('dragover', swallow)
    window.removeEventListener('drop', swallow)
  }
}
