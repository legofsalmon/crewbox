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
