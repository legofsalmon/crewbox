import { APP_VERSION } from './pwa.ts'
import { isNative, nativeScreens } from './server.ts'

/**
 * The page's side of the screens the apps run (native ScreensPlugin).
 *
 * In the apps these screens may have come from a box rather than with the
 * app. Screens from a box that don't say they started soon after they load
 * have failed on this phone, crashed or stuck before they could draw, and the
 * app goes back to the screens it came with. So once the first screen has
 * drawn, whatever it is, they say so, without waiting for the network: offline
 * is the ordinary case. The app's own screens say so too, which it takes as
 * nothing to do.
 */

/** Whether this load has said so. The app counts a start per load, and so does this. */
let told = false

/** Tell the app these screens have started. Once per load; nothing to do in a browser. */
export function screensStarted(): void {
  if (told) return
  told = true
  if (!isNative()) return
  // A refusal changes nothing here: the app goes back only on silence.
  nativeScreens()
    ?.ready({ version: APP_VERSION })
    .catch(() => {})
}
