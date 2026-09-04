/**
 * Shell keyboard-shortcut registry. One window listener; components and
 * modules register shortcuts on mount and unregister on cleanup, instead of
 * each attaching its own window handler (which fight each other once several
 * modules exist).
 *
 * Escape handling inside dialogs stays component-local — a dialog owning its
 * own lifetime is clearer than routing close-intent through a registry.
 */

export interface Shortcut {
  /** KeyboardEvent.key, compared case-insensitively (e.g. 'k', 'f'). */
  key: string
  /** Require Ctrl (Windows/Linux) or Cmd (macOS). */
  mod?: boolean
  shift?: boolean
  /** Extra guard checked before preventDefault — return false to let the
   * event through untouched (e.g. native text undo in a dirty input). */
  when?: (e: KeyboardEvent) => boolean
  handler: (e: KeyboardEvent) => void
}

/**
 * Is this key press happening inside the given view?
 *
 * A getter rather than an element, because the element is behind a ref when
 * the shortcut is registered. No scope means "anywhere", which is right for
 * a shell shortcut like Cmd+K.
 */
const inScope = (target: EventTarget | null, scope?: () => Element | null): boolean => {
  const root = scope?.()
  if (!root) return true
  return target instanceof Node && root.contains(target)
}

/**
 * The guard a document-level undo wants.
 *
 * Cmd/Ctrl+Z means two different things depending on where the caret is, and
 * the registry had no way to tell them apart — so while a patch sheet or a
 * lighting plot was mounted, Cmd+Z in the chat composer, the search overlay
 * or the admin panel reverted the *document* behind them. Silently, in the
 * admin panel's case, because it covers the grid.
 *
 * Three rules, in order:
 *
 *  - Typing outside this view: the browser's text undo, always. Somebody
 *    taking back a word they just typed has not asked about a patch sheet.
 *  - Typing inside it with an in-progress draft: the same, because there is
 *    text to take back and the browser owns it.
 *  - Anything else: the document's. A grid cell with nothing half-typed has
 *    no text undo of its own to give, and a press with nothing focused at
 *    all plainly means the thing on screen.
 */
export const documentUndoTarget =
  (scope?: () => Element | null) =>
  (e: KeyboardEvent): boolean => {
    const target = e.target as HTMLElement | null
    const typing =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target?.isContentEditable === true
    if (!typing) return true
    if (!inScope(target, scope)) return false
    return !target.dataset.dirty
  }

const shortcuts = new Set<Shortcut>()

/** Register a shortcut. Returns an unregister function for effect cleanup. */
export function registerShortcut(shortcut: Shortcut): () => void {
  shortcuts.add(shortcut)
  return () => shortcuts.delete(shortcut)
}

function matches(e: KeyboardEvent, s: Shortcut): boolean {
  if (e.key.toLowerCase() !== s.key.toLowerCase()) return false
  if (Boolean(s.mod) !== (e.metaKey || e.ctrlKey)) return false
  if (Boolean(s.shift) !== e.shiftKey) return false
  return true
}

if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => {
    for (const s of shortcuts) {
      if (matches(e, s) && (s.when?.(e) ?? true)) {
        e.preventDefault()
        s.handler(e)
        return
      }
    }
  })
}
