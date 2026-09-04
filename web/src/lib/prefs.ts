/**
 * Small per-device preferences, from a store that is allowed to be missing.
 *
 * `localStorage` is not "there or empty" — the accessor itself throws. A
 * browser set to block site data, a private window on older Safari, an
 * embedded webview with storage disabled: `localStorage.getItem` raises a
 * SecurityError rather than answering null, and reading one dismissed-tip
 * flag then takes the whole app down.
 *
 * That matters here more than it would elsewhere, because these reads happen
 * at the worst possible moment. `initialConfig()` runs while the store module
 * is being evaluated and `IosInstallTip` reads during its first render, so a
 * throw is not a missing preference — it is a blank screen on a phone
 * standing in a field, with nothing on it to explain itself and no way to
 * get past it. The IndexedDB cache learned the same lesson (see `db.ts`):
 * this is a cache of a person's preferences, and having none of it costs a
 * cream-coloured theme and a tip shown twice.
 *
 * Writes are the same shape: a quota that has run out, or a browser refusing
 * the write, must not break the thing that wanted to remember something.
 */

export function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Nothing here is worth an exception. It is remembered or it is not.
  }
}

export function forgetPref(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    /* as above */
  }
}
