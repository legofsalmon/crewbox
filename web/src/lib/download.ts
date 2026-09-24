import { isNative, nativeFiles, type FilePayload, type FilesPlugin } from './server.ts'

/**
 * Getting a file off the device, and knowing when that is not possible.
 *
 * Every export in the app was an `<a download>` click. In a browser that
 * saves a file; inside the Android and iOS shells the WebView has no
 * download handler at all, so the click does nothing whatsoever — and four
 * of the six export buttons went on to announce success. A crew chief
 * exporting the show report at the end of a festival got "Show report
 * downloaded" and no file, which is the worst possible answer: it is only
 * discovered later, by someone looking for a report that was never written.
 *
 * So each place a file can go is its own path:
 *
 * - A browser downloads it, as it always did.
 * - The Android app saves it to the phone's Downloads through its own plugin
 *   (native/android FilesPlugin), because Chromium leaves the Web Share API
 *   out of the Android web view; a bar at the foot of the app then offers to
 *   send it on.
 * - The iPhone app hands it to the share sheet, whose first row saves to
 *   Files, which is where an iPhone keeps a file.
 *
 * Whatever this cannot do, it says so — `unavailable` — rather than
 * announcing a success.
 */

export const NO_DOWNLOADS =
  'The app cannot save this file. Open this box in a phone browser to download it.'

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

/**
 * What happened to a file the crew asked for.
 *
 * - `saved`: downloaded by the browser, or in the Android phone's Downloads.
 * - `shared`: the share sheet took it.
 * - `waiting`: built, but the iPhone wants a fresh tap to share it: the bar
 *   at the foot of the app has it.
 * - `cancelled`: the share sheet was closed, which is not a failure.
 * - `unavailable`: this device cannot take the file at all.
 * - `failed`: a file on the box never arrived (see `deliverBoxFile`).
 */
export type Delivered = 'saved' | 'shared' | 'waiting' | 'cancelled' | 'unavailable' | 'failed'

/**
 * A file with one more thing to offer: sending on what was just saved, or
 * sharing what the iPhone would not share without another tap. Shown at the
 * foot of the app by <FileOfferBar />, one at a time, the newest winning.
 */
export interface FileOffer {
  id: number
  /** What happened, or what is waiting: "Saved to Downloads". */
  title: string
  /** The file's name, as the phone has it. */
  name: string
  /** The button, and what it does; an offer without one only reports. */
  action?: { label: string; run: () => void }
}

/** How long a saved file stays offered. One waiting to be shared stays until used. */
const SAVED_OFFER_MS = 10_000
/** How long a failure to share is shown for. */
const FAILED_OFFER_MS = 6_000

let offer: FileOffer | null = null
let offerSeq = 0
let offerTimer: ReturnType<typeof setTimeout> | undefined
const offerListeners = new Set<() => void>()

/** The offer on screen, for `useSyncExternalStore`. */
export const currentFileOffer = (): FileOffer | null => offer

export function subscribeFileOffer(listener: () => void): () => void {
  offerListeners.add(listener)
  return () => {
    offerListeners.delete(listener)
  }
}

export function dismissFileOffer(): void {
  setOffer(null)
}

function setOffer(next: Omit<FileOffer, 'id'> | null, lingerMs?: number): void {
  clearTimeout(offerTimer)
  offer = next && { ...next, id: ++offerSeq }
  if (offer && lingerMs) {
    const id = offer.id
    offerTimer = setTimeout(() => {
      if (offer?.id === id) setOffer(null)
    }, lingerMs)
  }
  for (const listener of offerListeners) listener()
}

const errorName = (err: unknown): string | undefined =>
  err && typeof err === 'object' && 'name' in err ? String(err.name) : undefined

/**
 * Can this device hand a file to the share sheet?
 *
 * `canShare` with the actual file, not just a feature check: iOS refuses
 * some types, and the only way to know is to ask about the file in hand.
 */
const canShareFile = (file: File): boolean => {
  const nav = navigator as Navigator & { canShare?: (data?: ShareData) => boolean }
  return typeof nav.share === 'function' && Boolean(nav.canShare?.({ files: [file] }))
}

/**
 * The iPhone: the share sheet, with "Save to Files" on it.
 *
 * WebKit shares only within five seconds of a tap, and several exports
 * spend longer than that fetching the whole log or drawing a test card
 * before there is a file to share. Refused for that (NotAllowedError), the
 * file is kept and offered at the foot of the app, where the tap on Share is
 * a new one. Closing the sheet rejects with AbortError, which is somebody
 * changing their mind, not a failure to report.
 */
async function shareOnIphone(file: File): Promise<Delivered> {
  if (!canShareFile(file)) return 'unavailable'
  try {
    await navigator.share({ files: [file] })
    return 'shared'
  } catch (err) {
    // InvalidStateError is a second tap while the sheet is still opening.
    if (errorName(err) === 'AbortError' || errorName(err) === 'InvalidStateError')
      return 'cancelled'
    if (errorName(err) !== 'NotAllowedError') return 'unavailable'
    setOffer({
      title: 'Ready to save or send',
      name: file.name,
      action: {
        label: 'Share',
        run: () => {
          setOffer(null)
          // Called from the bar's own tap, so WebKit has its activation.
          navigator.share({ files: [file] }).catch((retry: unknown) => {
            if (errorName(retry) !== 'AbortError') {
              setOffer({ title: 'Could not share', name: file.name }, FAILED_OFFER_MS)
            }
          })
        },
      },
    })
    return 'waiting'
  }
}

/** The Android app: into Downloads, then offered for sending on. */
async function saveOnAndroid(files: FilesPlugin, file: FilePayload): Promise<Delivered> {
  let saved: Awaited<ReturnType<FilesPlugin['save']>>
  try {
    saved = await files.save(file)
  } catch {
    // A file on the box that never arrived would only fail again.
    if (file.url !== undefined) return 'failed'
    // Downloads would not take one the page built (a full phone, or a
    // maker's odd storage), and the share sheet can still get it off the
    // phone.
    return shareOnAndroid(files, file)
  }
  if (!saved.saved) return 'cancelled'
  const name = saved.name ?? file.filename
  setOffer(
    {
      title: saved.folder ? `Saved to ${saved.folder}` : 'Saved',
      name,
      action: {
        label: 'Share',
        run: () => {
          setOffer(null)
          void shareOnAndroid(files, file).then((result) => {
            if (result !== 'shared') setOffer({ title: 'Could not share', name }, FAILED_OFFER_MS)
          })
        },
      },
    },
    SAVED_OFFER_MS
  )
  return 'saved'
}

async function shareOnAndroid(files: FilesPlugin, file: FilePayload): Promise<Delivered> {
  try {
    await files.share(file)
    return 'shared'
  } catch {
    return 'unavailable'
  }
}

const toBase64 = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''))
    reader.onerror = () => reject(reader.error ?? new Error('unreadable'))
    reader.readAsDataURL(blob)
  })

/**
 * Get a file the page has built to the crew member, however this device can
 * manage it. `unavailable` means none of the ways worked, and the caller
 * says so rather than announcing a success.
 */
export async function deliverFile(filename: string, blob: Blob): Promise<Delivered> {
  if (!isNative()) return saveFile(filename, blob) ? 'saved' : 'unavailable'
  const files = nativeFiles()
  if (!files) return shareOnIphone(new File([blob], filename, { type: blob.type }))
  let data: string
  try {
    data = await toBase64(blob)
  } catch {
    return 'unavailable'
  }
  return saveOnAndroid(files, { filename, mime: blob.type, data })
}

/** Same, for something already in hand as text. */
export const deliverText = (filename: string, mime: string, text: string): Promise<Delivered> =>
  deliverFile(filename, new Blob([text], { type: mime }))

/**
 * A file that is already on the box, by its address, for the apps. (A
 * browser needs none of this: a link with `download` saves it.)
 *
 * The Android app fetches it natively, so a large video goes from the box
 * to Downloads without passing through the page. The iPhone app has only
 * the share sheet, which wants the file itself, so the page fetches it
 * first; the box caps uploads at 100 MB, which a phone's web view holds.
 */
export async function deliverBoxFile(file: {
  url: string
  name: string
  mime: string
}): Promise<Delivered> {
  const files = nativeFiles()
  if (files) return saveOnAndroid(files, { filename: file.name, mime: file.mime, url: file.url })
  let blob: Blob
  try {
    const res = await fetch(file.url)
    if (!res.ok) return 'failed'
    blob = await res.blob()
  } catch {
    return 'failed'
  }
  return shareOnIphone(new File([blob], file.name, { type: file.mime || blob.type }))
}

/**
 * What the caller should say, or null for nothing.
 *
 * In the apps the bar at the foot of the screen, or the share sheet itself,
 * has already said what happened, and a cancel is nothing to report.
 */
export const deliveredNote = (result: Delivered, what: string): string | null => {
  if (result === 'unavailable') return NO_DOWNLOADS
  if (result === 'failed') return `Could not get ${what} from the box`
  if (result === 'saved' && !isNative()) return `${what} downloaded`
  return null
}
