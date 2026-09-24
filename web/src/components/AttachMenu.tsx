import { useEffect, useRef, type KeyboardEvent, type RefObject } from 'react'

/**
 * What the attach button offers in the Android app: a photo from the camera,
 * or a photo or file already on the phone.
 *
 * Everywhere else the phone asks by itself. An iPhone's picker opens with
 * Take Photo beside the library and files, and Chrome on Android offers its
 * camera alongside files. The Android app's web view sends a plain file input
 * straight to the system's file picker, which has no camera, so a crew member
 * who wanted to send a photo of what was in front of them had to leave the
 * app to take it and then come back and find it. "Take a photo" asks the web
 * view for a capture instead, which opens the camera.
 *
 * A menu like any other: arrow keys move through it, and Escape, a tap
 * outside or Android's back button close it (back sends it an Escape, see
 * shell/back.ts).
 */
export default function AttachMenu({
  anchor,
  onCamera,
  onFile,
  onClose,
}: {
  /** The attach button. It opens and closes the menu, so a tap on it is not a tap outside. */
  anchor: RefObject<HTMLElement | null>
  onCamera: () => void
  onFile: () => void
  onClose: () => void
}) {
  const menu = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // Keyboard and screen reader users land on the first choice.
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
  }, [])

  useEffect(() => {
    const outside = (e: PointerEvent) => {
      const target = e.target
      if (!(target instanceof Node)) return
      if (menu.current?.contains(target) || anchor.current?.contains(target)) return
      onClose()
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [anchor, onClose])

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onClose()
      anchor.current?.focus()
      return
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
    const at = items.findIndex((item) => item === document.activeElement)
    const step = e.key === 'ArrowDown' ? 1 : -1
    items[(at + step + items.length) % items.length]?.focus()
  }

  // The picker opens inside the tap that chose it: a file input opens only
  // for a user's gesture, so this cannot wait for the menu to close first.
  const choose = (open: () => void) => () => {
    open()
    onClose()
  }

  return (
    <div ref={menu} className="attach-menu" role="menu" aria-label="Attach" onKeyDown={onKeyDown}>
      <button role="menuitem" onClick={choose(onCamera)}>
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden>
          <path
            d="M4 8h3l1.5-2.5h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinejoin="round"
          />
          <circle cx="12" cy="13" r="3.5" fill="none" stroke="currentColor" strokeWidth="2" />
        </svg>
        Take a photo
      </button>
      <button role="menuitem" onClick={choose(onFile)}>
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden>
          <path
            d="M8 12.5 15.5 5a3.5 3.5 0 0 1 5 5l-9 9a5.5 5.5 0 0 1-7.8-7.8L11 4"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
        Choose a photo or file
      </button>
    </div>
  )
}
