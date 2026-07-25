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
