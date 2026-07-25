import { useCallback, useSyncExternalStore } from 'react'
import type * as Y from 'yjs'

const EVENTS = ['stack-item-added', 'stack-item-popped', 'stack-cleared'] as const

/** Live undo/redo state and actions for a sheet's UndoManager. */
export function useUndoRedo(undoManager: Y.UndoManager | undefined | null): {
  canUndo: boolean
  canRedo: boolean
  undo: () => void
  redo: () => void
} {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!undoManager) return () => {}
      for (const event of EVENTS) undoManager.on(event, onStoreChange)
      return () => {
        for (const event of EVENTS) undoManager.off(event, onStoreChange)
      }
    },
    [undoManager]
  )

  const canUndo = useSyncExternalStore(subscribe, () =>
    undoManager ? undoManager.undoStack.length > 0 : false
  )
  const canRedo = useSyncExternalStore(subscribe, () =>
    undoManager ? undoManager.redoStack.length > 0 : false
  )

  const undo = useCallback(() => {
    undoManager?.undo()
  }, [undoManager])
  const redo = useCallback(() => {
    undoManager?.redo()
  }, [undoManager])

  return { canUndo, canRedo, undo, redo }
}
