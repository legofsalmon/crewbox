// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deliveredNote, deliverFile, deliverText, saveFile, saveText } from './download.ts'

/**
 * The one thing worth asserting here is the answer the callers act on: a
 * shell that cannot save must say so, because four export buttons used to
 * announce success into a WebView that had quietly done nothing.
 */

const asNative = (native: boolean) => {
  ;(window as unknown as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => native,
  }
}

afterEach(() => {
  delete (window as unknown as { Capacitor?: unknown }).Capacitor
  vi.restoreAllMocks()
})

describe('saving a file', () => {
  it('saves in a browser and says it did', () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})

    expect(saveText('rig.csv', 'text/csv', 'channel,address')).toBe(true)
    expect(click).toHaveBeenCalledTimes(1)
  })

  it('does not pretend to save inside the native shell', () => {
    asNative(true)
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    expect(saveText('rig.csv', 'text/csv', 'channel,address')).toBe(false)
    expect(saveFile('report.html', new Blob(['<p>hi</p>']))).toBe(false)
    // Not even attempted: the click is the part that silently did nothing.
    expect(click).not.toHaveBeenCalled()
  })
})

describe('handing a file to somebody on a phone', () => {
  /**
   * Inside the Android and iOS shells there is no download handler, so the
   * anchor click does nothing whatsoever — but the share sheet works in both
   * WebViews, and for a network audit it is the better answer anyway: what
   * somebody does with one at a venue is send it to the venue's IT, which is
   * one tap from the share sheet and several from a downloads folder.
   */
  const withShare = (canShare: boolean, share = vi.fn().mockResolvedValue(undefined)) => {
    Object.assign(navigator, { share, canShare: () => canShare })
    return share
  }

  afterEach(() => {
    delete (navigator as { share?: unknown }).share
    delete (navigator as { canShare?: unknown }).canShare
  })

  it('downloads in a browser', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})

    expect(await deliverText('audit.html', 'text/html', '<p>hi</p>')).toBe('saved')
    expect(click).toHaveBeenCalledTimes(1)
  })

  it('offers the share sheet inside the native shell', async () => {
    asNative(true)
    const share = withShare(true)
    expect(await deliverFile('audit.html', new Blob(['<p>hi</p>']))).toBe('shared')
    expect(share).toHaveBeenCalledTimes(1)
    const [data] = share.mock.calls[0] as [{ files: File[] }]
    expect(data.files[0]!.name).toBe('audit.html')
  })

  it('says so when the shell will not take the file either', async () => {
    // Older WebViews refuse files entirely, and both platforms refuse some
    // types — which is why `canShare` is asked about the file in hand.
    asNative(true)
    withShare(false)
    expect(await deliverFile('audit.html', new Blob(['<p>hi</p>']))).toBe('unavailable')
  })

  it('treats a cancelled share as nothing having happened', async () => {
    asNative(true)
    withShare(true, vi.fn().mockRejectedValue(new Error('AbortError')))
    expect(await deliverFile('audit.html', new Blob(['x']))).toBe('unavailable')
  })

  it('has words for all three outcomes', () => {
    expect(deliveredNote('saved', 'Report')).toBe('Report downloaded')
    expect(deliveredNote('shared', 'Report')).toBe('Report ready to send')
    // Never "downloaded" for a file that is not anywhere.
    expect(deliveredNote('unavailable', 'Report')).toContain('cannot save')
  })
})
