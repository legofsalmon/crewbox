import { isNative } from './server.ts'

/**
 * Saving a file to the device, and knowing when that is not possible.
 *
 * Every export in the app was an `<a download>` click. In a browser that
 * saves a file; inside the Android and iOS shells the WebView has no
 * download handler at all, so the click does nothing whatsoever — and four
 * of the six export buttons went on to announce success. A crew chief
 * exporting the show report at the end of a festival got "Show report
 * downloaded" and no file, which is the worst possible answer: it is only
 * discovered later, by someone looking for a report that was never written.
 *
 * There is no way to fix the saving itself from here — it needs a native
 * file-share bridge the shells do not have yet — so what this fixes is the
 * lie. The box is on the same network as the phone and its browser can
 * still save anything, which is what the message says to do.
 */

export const NO_DOWNLOADS =
  'The app cannot save files. Open this box in a phone browser to download it.'

/** Save a blob under `filename`. False when the shell cannot save at all. */
export const saveFile = (filename: string, blob: Blob): boolean => {
  if (isNative()) return false
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
  return true
}

/** Same, for something already in hand as text. */
export const saveText = (filename: string, mime: string, text: string): boolean =>
  saveFile(filename, new Blob([text], { type: mime }))

/** What happened to a file the crew asked for. */
export type Delivered = 'saved' | 'shared' | 'unavailable'

/**
 * Can this device hand a file to the share sheet?
 *
 * `canShare` with the actual file, not just a feature check: Android and iOS
 * both refuse some types (and older WebViews refuse files entirely) and the
 * only way to know is to ask about the file in hand.
 */
const canShareFile = (file: File): boolean => {
  const nav = navigator as Navigator & { canShare?: (data?: ShareData) => boolean }
  return typeof nav.share === 'function' && Boolean(nav.canShare?.({ files: [file] }))
}

/**
 * Get a file to the crew member, however this device can manage it.
 *
 * In a browser that is a download. Inside the Android and iOS shells there
 * is no download handler at all, so the anchor click does nothing — but the
 * share sheet works in both WebViews, and it is the better answer anyway:
 * what somebody does with a network audit at a venue is send it to the
 * venue's IT, and that is one tap from the share sheet and several from the
 * downloads folder.
 *
 * `unavailable` means neither is possible, and the caller says so rather
 * than announcing a success — the failure this whole module exists to stop.
 */
export async function deliverFile(filename: string, blob: Blob): Promise<Delivered> {
  if (!isNative()) return saveFile(filename, blob) ? 'saved' : 'unavailable'
  try {
    const file = new File([blob], filename, { type: blob.type })
    if (!canShareFile(file)) return 'unavailable'
    await navigator.share({ files: [file], title: filename })
    return 'shared'
  } catch {
    // Cancelling the share sheet rejects, which is not a failure to report
    // — but there is nothing to announce either way, so it reads the same.
    return 'unavailable'
  }
}

/** Same, for something already in hand as text. */
export const deliverText = (filename: string, mime: string, text: string): Promise<Delivered> =>
  deliverFile(filename, new Blob([text], { type: mime }))

/** What to tell somebody, for each of the three outcomes. */
export const deliveredNote = (result: Delivered, what: string): string => {
  if (result === 'saved') return `${what} downloaded`
  if (result === 'shared') return `${what} ready to send`
  return NO_DOWNLOADS
}
