// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  currentFileOffer,
  deliverBoxFile,
  deliveredNote,
  deliverFile,
  deliverText,
  dismissFileOffer,
  saveFile,
  saveText,
  subscribeFileOffer,
} from './download.ts'
import type { FilePayload, FilesPlugin } from './server.ts'

/**
 * The one thing worth asserting here is the answer the callers act on: a
 * shell that cannot save must say so, because four export buttons used to
 * announce success into a WebView that had quietly done nothing. And now
 * that the apps can save, that each of them does it the way its phone
 * expects.
 */

const inBrowser = () => {
  delete window.Capacitor
}

const onIphone = () => {
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios', Plugins: {} }
}

/** The Android app, with a stand-in for its FilesPlugin. */
const onAndroid = (plugin: Partial<FilesPlugin> = {}) => {
  const files = {
    save: vi.fn<FilesPlugin['save']>(
      plugin.save ??
        (async (file: FilePayload) => ({ saved: true, name: file.filename, folder: 'Downloads' }))
    ),
    share: vi.fn<FilesPlugin['share']>(plugin.share ?? (async () => {})),
  }
  window.Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
    Plugins: { CrewboxFiles: files },
  }
  return files
}

const withShare = (
  share: (data: ShareData) => Promise<void> = vi.fn(async () => {}),
  canShare = true
) => {
  Object.assign(navigator, { share, canShare: () => canShare })
  return share as ReturnType<typeof vi.fn>
}

const refused = (name: string) => Promise.reject(new DOMException('refused', name))

afterEach(() => {
  inBrowser()
  dismissFileOffer()
  delete (navigator as { share?: unknown }).share
  delete (navigator as { canShare?: unknown }).canShare
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('in a browser', () => {
  it('saves and says it did', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})

    expect(saveText('rig.csv', 'text/csv', 'channel,address')).toBe(true)
    expect(await deliverText('audit.html', 'text/html', '<p>hi</p>')).toBe('saved')
    expect(click).toHaveBeenCalledTimes(2)
    expect(deliveredNote('saved', 'Report')).toBe('Report downloaded')
  })

  it('does not pretend to save with a link inside the apps', () => {
    onIphone()
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    expect(saveText('rig.csv', 'text/csv', 'channel,address')).toBe(false)
    expect(saveFile('report.html', new Blob(['<p>hi</p>']))).toBe(false)
    // Not even attempted: the click is the part that silently did nothing.
    expect(click).not.toHaveBeenCalled()
  })
})

describe('in the iPhone app', () => {
  /**
   * The web view has the share sheet, and its first row saves to Files, so
   * that is where a file goes.
   */
  it('hands the file to the share sheet', async () => {
    onIphone()
    const share = withShare()
    expect(await deliverFile('audit.html', new Blob(['<p>hi</p>'], { type: 'text/html' }))).toBe(
      'shared'
    )
    const [data] = share.mock.calls[0] as [{ files: File[] }]
    expect(data.files[0]!.name).toBe('audit.html')
    expect(data.files[0]!.type).toBe('text/html')
    // The sheet has said all there is to say.
    expect(deliveredNote('shared', 'Report')).toBeNull()
  })

  it('says so when the phone will not take the file', async () => {
    // iOS refuses some types, which is why `canShare` is asked about the
    // file in hand.
    onIphone()
    withShare(undefined, false)
    const result = await deliverFile('audit.html', new Blob(['<p>hi</p>']))
    expect(result).toBe('unavailable')
    expect(deliveredNote(result, 'Report')).toContain('cannot save')
  })

  it('treats closing the sheet as a change of mind, not a failure', async () => {
    // It used to report "cannot save files" to somebody who had just
    // decided not to.
    onIphone()
    withShare(() => refused('AbortError'))
    const result = await deliverFile('audit.html', new Blob(['x']))
    expect(result).toBe('cancelled')
    expect(deliveredNote(result, 'Report')).toBeNull()
  })

  it('shrugs off a second tap while the sheet is opening', async () => {
    onIphone()
    withShare(() => refused('InvalidStateError'))
    expect(await deliverFile('audit.html', new Blob(['x']))).toBe('cancelled')
  })

  it('keeps a file that took too long to build, for a fresh tap', async () => {
    // WebKit shares only within five seconds of a tap. Paging in a whole
    // festival's log can take longer, and then the file needs a new one.
    onIphone()
    const share = withShare(vi.fn(() => refused('NotAllowedError')))
    const result = await deliverFile('show-report.html', new Blob(['<p>night</p>']))
    expect(result).toBe('waiting')
    expect(deliveredNote(result, 'Show report')).toBeNull()

    const offer = currentFileOffer()!
    expect(offer).toMatchObject({ title: 'Ready to save or send', name: 'show-report.html' })
    expect(offer.action!.label).toBe('Share')

    share.mockImplementation(async () => {})
    offer.action!.run()
    expect(share).toHaveBeenCalledTimes(2)
    const [data] = share.mock.calls[1] as [{ files: File[] }]
    expect(data.files[0]!.name).toBe('show-report.html')
    expect(currentFileOffer()).toBeNull()
  })

  it('fetches a file on the box and shares it under its own name', async () => {
    onIphone()
    const share = withShare()
    const fetched = vi.fn(async () => new Response(new Blob(['PDF']), { status: 200 }))
    vi.stubGlobal('fetch', fetched)
    const result = await deliverBoxFile({
      url: 'http://10.0.0.2:3000/api/files/f1/rider.pdf',
      name: 'rider.pdf',
      mime: 'application/pdf',
    })
    expect(result).toBe('shared')
    expect(fetched).toHaveBeenCalledWith('http://10.0.0.2:3000/api/files/f1/rider.pdf')
    const [data] = share.mock.calls[0] as [{ files: File[] }]
    expect(data.files[0]!.name).toBe('rider.pdf')
    expect(data.files[0]!.type).toBe('application/pdf')
  })

  it('says the box is the problem when a file never arrives', async () => {
    onIphone()
    const share = withShare()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('gone', { status: 404 }))
    )
    const file = { url: 'http://box/api/files/f1/a.pdf', name: 'a.pdf', mime: 'application/pdf' }
    expect(await deliverBoxFile(file)).toBe('failed')
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('offline')))
    )
    expect(await deliverBoxFile(file)).toBe('failed')
    expect(share).not.toHaveBeenCalled()
    expect(deliveredNote('failed', 'the rider')).toBe('Could not get the rider from the box')
  })
})

describe('in the Android app', () => {
  /**
   * Chromium leaves the Web Share API out of the Android web view, so every
   * export here said it could not save. The app's own plugin saves to
   * Downloads, and a bar at the foot of the app offers to send it on.
   */
  it('saves a file the page built to Downloads', async () => {
    const files = onAndroid()
    const result = await deliverText('rig.csv', 'text/csv;charset=utf-8', 'channel,address')
    expect(result).toBe('saved')
    const [payload] = files.save.mock.calls[0]!
    expect(payload.filename).toBe('rig.csv')
    expect(payload.mime).toBe('text/csv;charset=utf-8')
    expect(atob(payload.data!)).toBe('channel,address')
    expect(files.share).not.toHaveBeenCalled()

    // The bar, not the caller, says where it went.
    expect(deliveredNote(result, 'Sheet CSV')).toBeNull()
    expect(currentFileOffer()).toMatchObject({ title: 'Saved to Downloads', name: 'rig.csv' })
  })

  it('names the file as Downloads did, when a clash renamed it', async () => {
    onAndroid({ save: async () => ({ saved: true, name: 'rig (1).csv', folder: 'Downloads' }) })
    await deliverText('rig.csv', 'text/csv', 'a')
    expect(currentFileOffer()!.name).toBe('rig (1).csv')
  })

  it('offers the saved file to the share sheet', async () => {
    const files = onAndroid()
    await deliverText('audit.html', 'text/html', '<p>hi</p>')
    currentFileOffer()!.action!.run()
    expect(files.share).toHaveBeenCalledTimes(1)
    // The same file, not a second build of it.
    expect(files.share.mock.calls[0]![0]).toEqual(files.save.mock.calls[0]![0])
    expect(currentFileOffer()).toBeNull()
  })

  it('says so when sending it on fails', async () => {
    onAndroid({ share: () => Promise.reject(new Error('no apps')) })
    await deliverText('audit.html', 'text/html', '<p>hi</p>')
    currentFileOffer()!.action!.run()
    await vi.waitFor(() =>
      expect(currentFileOffer()).toMatchObject({ title: 'Could not share', name: 'audit.html' })
    )
    expect(currentFileOffer()!.action).toBeUndefined()
  })

  it('lets the saved offer go after a while', async () => {
    vi.useFakeTimers()
    onAndroid()
    await deliverText('rig.csv', 'text/csv', 'a')
    const seen = vi.fn()
    const unsubscribe = subscribeFileOffer(seen)
    vi.advanceTimersByTime(9_000)
    expect(currentFileOffer()).not.toBeNull()
    vi.advanceTimersByTime(1_000)
    expect(currentFileOffer()).toBeNull()
    expect(seen).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('says only "saved" where the phone asked where to save', async () => {
    // Android 9 and older: the system's "save as" screen, which could be
    // pointed anywhere.
    onAndroid({ save: async () => ({ saved: true, name: 'rig.csv' }) })
    await deliverText('rig.csv', 'text/csv', 'a')
    expect(currentFileOffer()).toMatchObject({ title: 'Saved', name: 'rig.csv' })
  })

  it('treats backing out of "save as" as nothing having happened', async () => {
    onAndroid({ save: async () => ({ saved: false }) })
    const result = await deliverText('rig.csv', 'text/csv', 'a')
    expect(result).toBe('cancelled')
    expect(deliveredNote(result, 'Plot')).toBeNull()
    expect(currentFileOffer()).toBeNull()
  })

  it('shares a built file that Downloads would not take', async () => {
    const files = onAndroid({ save: () => Promise.reject(new Error('disk full')) })
    expect(await deliverText('rig.csv', 'text/csv', 'a')).toBe('shared')
    expect(files.share).toHaveBeenCalledTimes(1)
  })

  it('says so when neither works', async () => {
    onAndroid({
      save: () => Promise.reject(new Error('disk full')),
      share: () => Promise.reject(new Error('no apps')),
    })
    const result = await deliverText('rig.csv', 'text/csv', 'a')
    expect(result).toBe('unavailable')
    expect(deliveredNote(result, 'Plot')).toContain('cannot save')
  })

  it('has the app fetch a file on the box, not the page', async () => {
    // A 100 MB video should go from the box to Downloads without crossing
    // the bridge as text.
    const files = onAndroid()
    const fetched = vi.fn()
    vi.stubGlobal('fetch', fetched)
    const result = await deliverBoxFile({
      url: 'http://10.0.0.2:3000/api/files/f1/walk-in.mp4',
      name: 'walk-in.mp4',
      mime: 'video/mp4',
    })
    expect(result).toBe('saved')
    expect(files.save).toHaveBeenCalledWith({
      filename: 'walk-in.mp4',
      mime: 'video/mp4',
      url: 'http://10.0.0.2:3000/api/files/f1/walk-in.mp4',
    })
    expect(fetched).not.toHaveBeenCalled()
  })

  it('does not retry a file on the box that never arrived', async () => {
    const files = onAndroid({ save: () => Promise.reject(new Error('The box answered 404')) })
    const result = await deliverBoxFile({ url: 'http://box/f', name: 'f.pdf', mime: '' })
    expect(result).toBe('failed')
    expect(files.share).not.toHaveBeenCalled()
  })
})
