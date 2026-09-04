// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { documentUndoTarget } from './keys.ts'

/**
 * Cmd/Ctrl+Z means two different things depending on where the caret is, and
 * the registry had no way to tell them apart — so while a patch sheet or a
 * lighting plot was mounted, Cmd+Z in the chat composer, the search overlay
 * or the admin panel reverted the *document* behind them. Silently, in the
 * admin panel's case, because it covers the grid.
 */

const view = () => {
  const root = document.createElement('div')
  document.body.append(root)
  return root
}

const press = (target: EventTarget | null) => ({ target }) as unknown as KeyboardEvent

const input = (into: HTMLElement | null, attrs: Record<string, string> = {}) => {
  const el = document.createElement('input')
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  ;(into ?? document.body).append(el)
  return el
}

describe('who owns Cmd+Z', () => {
  it('the field, when the caret is outside this view', () => {
    // The chat composer, the search overlay, an admin panel dialog. Somebody
    // taking back a word they just typed has not asked about a patch sheet.
    const root = view()
    const elsewhere = input(null)
    expect(documentUndoTarget(() => root)(press(elsewhere))).toBe(false)
  })

  it('the field, when there is a draft in progress inside the view', () => {
    const root = view()
    const cell = input(root, { 'data-dirty': 'true' })
    expect(documentUndoTarget(() => root)(press(cell))).toBe(false)
  })

  it('the document, in a cell of this view with nothing half-typed', () => {
    // The case the shortcut exists for, and the one where the browser has no
    // text undo of its own to give.
    const root = view()
    const cell = input(root)
    expect(documentUndoTarget(() => root)(press(cell))).toBe(true)
  })

  it('the document, when nothing is focused at all', () => {
    const root = view()
    expect(documentUndoTarget(() => root)(press(document.body))).toBe(true)
    expect(documentUndoTarget(() => root)(press(null))).toBe(true)
  })

  it('the document, for a view that has not mounted its root yet', () => {
    // An effect that runs before the ref is attached must not disable the
    // shortcut for the life of the view.
    const elsewhere = input(null)
    expect(documentUndoTarget(() => null)(press(elsewhere))).toBe(true)
  })
})
