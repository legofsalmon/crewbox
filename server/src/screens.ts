import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The signed list of the screens this box serves, as an app asks for it
 * (`GET /api/app/screens`).
 *
 * A release builds its screens once and signs a list of them with the release
 * key (scripts/sign-web.mjs): `WEBSUMS`, one `sha256sum` line per file, and
 * `WEBSUMS.sig`, its Ed25519 signature in base64. Both sit among the screens,
 * so every box built on them carries them, and extracts them with the rest
 * into the folder it serves for its own version (extractWebDist in box.ts).
 * A box rolled back to an older version answers with that version's list,
 * beside that version's files.
 *
 * The box checks none of it. The app checks the signature against keys it was
 * built with, and each file against the list, because a check made by the
 * thing being checked is no check. The box only hands over what it has.
 *
 * The names are the release's own, pinned against scripts/web-sums.mjs by
 * server/test/appScreens.test.mjs.
 */
export const SCREENS_SUMS = 'WEBSUMS'
export const SCREENS_SIGNATURE = 'WEBSUMS.sig'

export interface SignedScreens {
  /** The list exactly as it was signed: the app checks the signature over these bytes. */
  sums: string
  /** The signature, base64, without the file's newline. */
  signature: string
}

/**
 * What the screens in `webDist` have to show for themselves: their signed
 * list, or null when there is none to show. That is a development box, a
 * fork, or a box from before releases signed their screens, and an app takes
 * it as "keep your own screens".
 */
export function signedScreens(webDist: string | undefined): SignedScreens | null {
  if (!webDist) return null
  try {
    return {
      sums: readFileSync(join(webDist, SCREENS_SUMS), 'utf8'),
      signature: readFileSync(join(webDist, SCREENS_SIGNATURE), 'utf8').trim(),
    }
  } catch {
    return null
  }
}
