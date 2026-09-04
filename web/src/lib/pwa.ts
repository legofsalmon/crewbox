import { registerSW } from 'virtual:pwa-register'

export const APP_VERSION: string =
  typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0+unknown'

/**
 * Whether a version string names a specific build.
 *
 * A tree with no git — a release tarball — gives both the client and the
 * server a `+unknown` commit, and two of those are not evidence of
 * anything. Comparing them raised "New version available" against the build
 * already running, on every welcome, for ever.
 */
export const knownBuild = (version: string): boolean => !version.endsWith('+unknown')

/** The live SW registration, so an update check can be forced on demand. */
let swRegistration: ServiceWorkerRegistration | undefined

/**
 * Register the service worker in prompt mode. When a new build is deployed,
 * `onNeedRefresh` fires while the app is running (or on next open) — we tell
 * the store rather than silently reloading, so a crew member never loses
 * their place mid-message. Reloading is always safe: unsent messages live
 * in the IndexedDB outbox and flush after reload.
 */
export function initPwa(onUpdateReady: () => void): (reload?: boolean) => Promise<void> {
  const updateSW = registerSW({
    onNeedRefresh: onUpdateReady,
    onRegisteredSW(_swUrl, registration) {
      swRegistration = registration
      // Re-check for a new build every 30 min so long-running installed apps
      // (a phone left in a pocket all shift) eventually notice a redeploy.
      if (registration) {
        // Caught, because offline is the ordinary case here rather than a
        // fault: a box in a field has no internet, and an uncaught reject
        // every half hour is an unhandled rejection in every crew member's
        // console for the whole show.
        setInterval(() => void registration.update().catch(() => {}), 30 * 60 * 1000)
      }
    },
  })
  return updateSW
}

/**
 * Force the service worker to check for a new build now.
 *
 * The reconnect welcome can spot a redeploy (its server version differs) long
 * before the 30-minute periodic check would — but the "Reload" pill only does
 * anything once the SW has actually fetched the new worker and it is waiting.
 * Kicking the check here makes that worker appear within seconds, so the pill
 * the welcome raised is not a dead button until the next periodic sweep.
 */
export function checkForUpdate(): void {
  void swRegistration?.update()
}
