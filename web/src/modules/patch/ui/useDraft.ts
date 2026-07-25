import { useRef, useState } from 'react'

/**
 * Local draft editing for a synced value: the input shows the shared value
 * until the user types, then holds a local draft that commits on blur/Enter
 * and reverts on Escape. While a draft is active, remote updates do NOT
 * overwrite what the user is typing (v1 lost in-progress edits this way) —
 * they appear once the field is left.
 *
 * The draft begins on the first change (not on focus), so merely focusing a
 * field doesn't mark it dirty — the doc-level undo shortcut uses the
 * `data-dirty` marker to leave in-progress text edits to the browser's own
 * text undo.
 *
 * `multiline` (for textareas) keeps Enter as a newline; commit is blur-only.
 */
export function useDraft(
  value: string,
  commit: (next: string) => void,
  options?: { multiline?: boolean }
) {
  const [draft, setDraft] = useState<string | null>(null)
  // Blur fires synchronously on .blur() before React re-renders, so the
  // handler reads the live ref rather than a stale closure value.
  const draftRef = useRef<string | null>(null)

  const set = (next: string | null) => {
    draftRef.current = next
    setDraft(next)
  }

  return {
    value: draft ?? value,
    editing: draft !== null,
    /** Discard any in-progress draft (e.g. after an external write to the field). */
    reset: () => set(null),
    inputProps: {
      value: draft ?? value,
      'data-dirty': draft !== null ? 'true' : undefined,
      onChange: (e: { target: { value: string } }) => set(e.target.value),
      onBlur: () => {
        const current = draftRef.current
        if (current !== null && current !== value) commit(current)
        set(null)
      },
      onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
        if (e.key === 'Enter' && !options?.multiline) {
          ;(e.target as HTMLElement).blur()
        } else if (e.key === 'Escape') {
          set(null)
          ;(e.target as HTMLElement).blur()
        }
      },
    },
  }
}
