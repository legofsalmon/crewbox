import { isIOS } from '../../../lib/devices.ts'
import { isAndroidApp, isNative } from '../../../lib/server.ts'

/**
 * Which files a plot takes, and which file pickers can offer them.
 *
 * Shared by the plot list and a plot's own Import button, and by the drop
 * zones on both, so a file is judged the same whichever way it arrives.
 */

const RIG_FILES = '.csv,.mvr,text/csv'

/** A file a plot imports, by its name: a designer's MVR, or a CSV. */
export const isRigFile = (file: Pick<File, 'name'>): boolean => /\.(csv|mvr)$/i.test(file.name)

/**
 * The `accept` for a rig file input.
 *
 * On a computer the list narrows the file dialog to files that import. On a
 * phone it kept MVRs out of reach, because a phone's picker filters by MIME
 * type and there is none for .mvr:
 *
 *  - In the Android app, Capacitor turns each extension into a type through
 *    Android's own table (`BridgeWebChromeClient.getValidTypes`), drops the
 *    ones it has none for, and opens the picker for what is left: CSVs.
 *  - On an iPhone, in the app or a browser, WebKit does the same through its
 *    own table (`WKFileUploadPanel`), and the document picker it opens is
 *    limited to the types that come out: CSVs again.
 *
 * So neither gets a list, and both offer every file, which on an iPhone
 * means the photo library and the camera are offered too. Whatever is
 * chosen goes through `rigFileProblem`. Chrome on Android turns an
 * extension it has no type for into `application/octet-stream` and then
 * offers every file (`SelectFileDialog.ensureMimeType`), so a phone's
 * browser there keeps the list, as a computer does.
 */
export function rigFileAccept(): string | undefined {
  return isAndroidApp() || isIOS() ? undefined : RIG_FILES
}

/**
 * The largest rig file a phone is asked to read, in megabytes.
 *
 * Reasoned, not measured on a phone: no phone has been run out of memory to
 * find the real edge. What was measured is the cost, in desktop Chromium,
 * the engine inside Android's web view: while it runs, an import takes
 * about one and a half times the file's size in memory, so a file this size
 * costs around 170 MB for a second or two, which any phone from the last
 * several years should have to spare.
 */
export const PHONE_LIMIT_MB = 100

/**
 * A phone or a tablet, as far as memory goes: one of the apps, or a browser
 * whose only pointer is a finger. The apps are named outright because some
 * Android web views have reported a mouse that isn't there.
 */
const onAPhone = (): boolean =>
  isNative() ||
  (typeof matchMedia === 'function' && matchMedia('(hover: none) and (pointer: coarse)').matches)

/**
 * Why a file won't be imported here, in words for the person who chose it,
 * or null when it will.
 *
 * A phone is refused a file too big to read safely. An import holds all of
 * a file in memory while it reads it, and a web view that runs out doesn't
 * fail the import: the Android app closes, and the iPhone app starts over.
 * The plot is shared with everyone on the box, so importing on a computer
 * instead loses nothing.
 */
export function rigFileProblem(
  file: Pick<File, 'name' | 'size'>,
  phone: boolean = onAPhone()
): string | null {
  if (!isRigFile(file)) return `${file.name} isn’t a CSV or MVR`
  const mb = file.size / (1024 * 1024)
  if (phone && mb > PHONE_LIMIT_MB) {
    return (
      `${file.name} is ${Math.round(mb)} MB, too big to read on a phone. ` +
      `Import it on a computer, and the plot reaches every phone on the box.`
    )
  }
  return null
}
