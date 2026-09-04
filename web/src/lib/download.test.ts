// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { saveFile, saveText } from './download.ts'

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
