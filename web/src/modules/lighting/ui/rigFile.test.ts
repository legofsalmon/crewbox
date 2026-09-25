// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isRigFile, PHONE_LIMIT_MB, rigFileAccept, rigFileProblem } from './rigFile.ts'

/**
 * Which files a plot takes, and what a file picker is asked to offer. The
 * pickers themselves are the platforms': what the page hands them is tested
 * here, and in e2e/android.spec.ts for the Android app.
 */

const MB = 1024 * 1024
const file = (name: string, size = 1000) => ({ name, size })

/** The page as one of the apps sees it: Capacitor's object on the window. */
const inApp = (platform: 'android' | 'ios') => {
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => platform }
}

const userAgent = (ua: string) =>
  Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true })

const touchOnly = (matches: boolean) =>
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query) =>
      ({
        matches: matches && query === '(hover: none) and (pointer: coarse)',
        media: query,
      }) as MediaQueryList
  )

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'

afterEach(() => {
  delete window.Capacitor
  delete (navigator as { userAgent?: string }).userAgent
  vi.restoreAllMocks()
})

describe('a rig file', () => {
  it('is an MVR or a CSV, by its name', () => {
    expect(isRigFile(file('Main Stage.mvr'))).toBe(true)
    expect(isRigFile(file('RIG.MVR'))).toBe(true)
    expect(isRigFile(file('patch.csv'))).toBe(true)
    expect(isRigFile(file('rig.mvr.zip'))).toBe(false)
    expect(isRigFile(file('mvr'))).toBe(false)
    expect(isRigFile(file('IMG_0042.jpg'))).toBe(false)
  })

  it('is turned away when it is something else, whatever the device', () => {
    for (const phone of [true, false]) {
      expect(rigFileProblem(file('Rider.pdf'), phone)).toBe('Rider.pdf isn’t a CSV or MVR')
    }
  })

  it('is turned away on a phone once it is bigger than a phone can read', () => {
    expect(rigFileProblem(file('rig.mvr', PHONE_LIMIT_MB * MB), true)).toBeNull()
    expect(rigFileProblem(file('rig.mvr', 180 * MB), true)).toBe(
      'rig.mvr is 180 MB, too big to read on a phone. ' +
        'Import it on a computer, and the plot reaches every phone on the box.'
    )
  })

  it('is read on a computer at any size', () => {
    expect(rigFileProblem(file('rig.mvr', 900 * MB), false)).toBeNull()
  })

  it('counts as on a phone in a browser with only a finger for a pointer', () => {
    touchOnly(true)
    expect(rigFileProblem(file('rig.mvr', 180 * MB))).toMatch(/too big/)
    touchOnly(false)
    expect(rigFileProblem(file('rig.mvr', 180 * MB))).toBeNull()
  })

  it('counts as on a phone in either app, whatever its web view says of its pointer', () => {
    touchOnly(false)
    for (const platform of ['android', 'ios'] as const) {
      inApp(platform)
      expect(rigFileProblem(file('rig.mvr', 180 * MB))).toMatch(/too big/)
    }
  })
})

describe('the file picker', () => {
  it('narrows to rig files on a computer', () => {
    expect(rigFileAccept()).toBe('.csv,.mvr,text/csv')
  })

  it('offers every file in the Android app, which cannot ask for an MVR by type', () => {
    inApp('android')
    expect(rigFileAccept()).toBeUndefined()
  })

  it('offers every file on an iPhone, in the app or a browser, which cannot either', () => {
    userAgent(IPHONE)
    expect(rigFileAccept()).toBeUndefined()
    inApp('ios')
    expect(rigFileAccept()).toBeUndefined()
  })
})
