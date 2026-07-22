import { registerSW } from 'virtual:pwa-register'

export const APP_VERSION: string =
  typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev'

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
      // Re-check for a new build every 30 min so long-running installed apps
      // (a phone left in a pocket all shift) eventually notice a redeploy.
      if (registration) {
        setInterval(() => void registration.update(), 30 * 60 * 1000)
      }
    },
  })
  return updateSW
}
