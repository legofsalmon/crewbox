import { describe, expect, it, vi } from 'vitest'
import type { DragEvent } from 'react'
import { dragHasFiles, guardStrayFileDrops } from './useFileDrop.ts'

/**
 * The hook itself needs a DOM to exercise; what is worth pinning without one
 * is the judgement inside it — what counts as a file drag, and what happens
 * to a drop that misses every target.
 */

const dragEvent = (types: string[]): DragEvent =>
  ({ dataTransfer: { types } }) as unknown as DragEvent

describe('telling a file drag from any other drag', () => {
  it('recognises files', () => {
    expect(dragHasFiles(dragEvent(['Files']))).toBe(true)
  })

  it('ignores dragged text', () => {
    // Highlighting a message and dragging it must not light up a drop target
    // that would do nothing when released.
    expect(dragHasFiles(dragEvent(['text/plain']))).toBe(false)
  })

  it('ignores a dragged link', () => {
    expect(dragHasFiles(dragEvent(['text/uri-list', 'text/plain']))).toBe(false)
  })

  it('accepts a drag carrying files alongside text', () => {
    // Dragging a file out of some apps includes a text/plain path as well.
    expect(dragHasFiles(dragEvent(['text/plain', 'Files']))).toBe(true)
  })

  it('treats a drag with no transfer as not-a-file-drag', () => {
    expect(dragHasFiles({} as DragEvent)).toBe(false)
  })
})

describe('a file dropped where nothing is listening', () => {
  /** Minimal window stub that records listeners and can fire them. */
  const withWindow = (run: (fire: (type: string, e: Event) => void) => void) => {
    const listeners = new Map<string, EventListener[]>()
    const original = globalThis.window
    globalThis.window = {
      addEventListener: (t: string, fn: EventListener) =>
        listeners.set(t, [...(listeners.get(t) ?? []), fn]),
      removeEventListener: (t: string, fn: EventListener) =>
        listeners.set(
          t,
          (listeners.get(t) ?? []).filter((f) => f !== fn)
        ),
    } as unknown as Window & typeof globalThis
    try {
      run((type, e) => listeners.get(type)?.forEach((fn) => fn(e)))
    } finally {
      globalThis.window = original
    }
  }

  const fileDrop = () => {
    const preventDefault = vi.fn()
    return {
      event: { dataTransfer: { types: ['Files'] }, preventDefault } as unknown as Event,
      preventDefault,
    }
  }

  it('is swallowed rather than opened', () => {
    // The browser's default is to navigate to the file, throwing away a
    // running app with unsent messages in its outbox. Missing the target
    // must do nothing at all.
    withWindow((fire) => {
      guardStrayFileDrops()
      const { event, preventDefault } = fileDrop()
      fire('drop', event)
      expect(preventDefault).toHaveBeenCalled()
    })
  })

  it('leaves ordinary drags alone', () => {
    // Dragging text within a textarea to reorder it still has to work.
    withWindow((fire) => {
      guardStrayFileDrops()
      const preventDefault = vi.fn()
      fire('drop', { dataTransfer: { types: ['text/plain'] }, preventDefault } as unknown as Event)
      expect(preventDefault).not.toHaveBeenCalled()
    })
  })

  it('stops listening when torn down', () => {
    withWindow((fire) => {
      const stop = guardStrayFileDrops()
      stop()
      const { event, preventDefault } = fileDrop()
      fire('drop', event)
      expect(preventDefault).not.toHaveBeenCalled()
    })
  })
})
