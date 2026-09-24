import { useStore } from '../store.ts'
import { nativeApp } from '../lib/server.ts'

/**
 * Android's back button, inside the app.
 *
 * The app had no handler for it, so back went straight to the system, which
 * puts the whole app away. Somebody who opened a photo, search or the audio
 * settings on a phone and pressed back to close it was taken out of crewbox
 * instead.
 *
 * Capacitor's App plugin goes back through the web view's history until
 * something listens for the button, and then leaves every press to the
 * listener. So this answers all of them, in the order a phone user expects:
 *
 *  1. The dialog on top gets an Escape. Each dialog already owns how it
 *     closes (see keys.ts), and back is one more way of asking it to: the
 *     same handler runs, with the same exceptions. One that ignores Escape,
 *     like the account deletion while it is deleting, keeps the press, so
 *     back never leaves the screen underneath an open dialog. A field that
 *     was being typed in is left first, the way tapping outside it would
 *     leave it, so an edit in progress is kept rather than thrown away.
 *  2. The drawer closes.
 *  3. The app goes back through its own history: the channels and module
 *     views the router pushed.
 *  4. With nothing left, the app goes to the background, as it would for
 *     the home button. Closing it would end a voice call and throw away the
 *     page, for a press that usually means "not now".
 */

/** What a back press did, so the caller knows whether the app should leave. */
export type BackStep = 'dialog' | 'drawer' | 'history' | 'background'

/**
 * The dialog a back press is for: the last open one in the document.
 *
 * Overlays render after the shell, and a confirmation inside a panel comes
 * after the panel, so document order puts the one on top last.
 * `checkVisibility` leaves out a dialog that is mounted but not showing,
 * which would otherwise take every press for ever.
 */
export function topmostDialog(root: ParentNode = document): HTMLElement | null {
  const dialogs = [
    ...root.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]'),
  ].filter((el) => el.checkVisibility())
  return dialogs.at(-1) ?? null
}

/** Answer one back press. `canGoBack` is the web view's own history. */
export function goBack(canGoBack: boolean): BackStep {
  const dialog = topmostDialog()
  if (dialog) {
    // Blur before the Escape, not after: a draft field reverts on Escape and
    // saves on blur, and on a phone back means "done here", not "undo".
    const focused = document.activeElement
    if (focused instanceof HTMLElement && dialog.contains(focused)) focused.blur()
    dialog.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        code: 'Escape',
        bubbles: true,
        cancelable: true,
      })
    )
    return 'dialog'
  }
  const { sidebarOpen, setSidebarOpen } = useStore.getState()
  if (sidebarOpen) {
    setSidebarOpen(false)
    return 'drawer'
  }
  if (canGoBack) {
    history.back()
    return 'history'
  }
  return 'background'
}

/** Take over the back button, in the native app only. */
export function installBackButton(): void {
  const app = nativeApp()
  if (!app) return
  app.addListener('backButton', ({ canGoBack }) => {
    if (goBack(canGoBack) === 'background') void app.minimizeApp()
  })
}
