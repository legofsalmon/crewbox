import { describe, expect, it } from 'vitest'
import {
  isSafariFrom,
  mixConflictsWithOutputPicker,
  shouldMixThroughWebAudio,
} from './voice-playback.ts'

/**
 * Which browsers get the mixed audio graph.
 *
 * This decides how sound reaches the ear, and the failure it guards against
 * is silent: a crew member on comms, connected, hearing nobody. So the
 * platform test is pinned to real user-agent strings rather than to a
 * hand-wave about "Safari".
 */

const UA = {
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  macSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  macChrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  iosChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.0.0 Mobile/15E148 Safari/604.1',
  androidChrome:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  firefox: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:127.0) Gecko/20100101 Firefox/127.0',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
}

describe('telling Safari from everything wearing its name', () => {
  it('knows the real thing on a Mac and on a phone', () => {
    expect(isSafariFrom(UA.macSafari)).toBe(true)
    expect(isSafariFrom(UA.iphone)).toBe(true)
  })

  it('is not fooled by the browsers that put Safari in their own string', () => {
    // Every Chromium browser ships "Safari/537.36". Matching on that alone
    // would turn the mix on for most of the desktop world.
    expect(isSafariFrom(UA.macChrome)).toBe(false)
    expect(isSafariFrom(UA.androidChrome)).toBe(false)
    expect(isSafariFrom(UA.edge)).toBe(false)
    expect(isSafariFrom(UA.firefox)).toBe(false)
  })

  it('treats Chrome on iOS as Chrome, not Safari', () => {
    // It is WebKit underneath and still needs the mix — but it gets there
    // through the iOS check, not by being mistaken for Safari.
    expect(isSafariFrom(UA.iosChrome)).toBe(false)
  })
})

describe('who gets the mixed graph', () => {
  it('mixes on iOS whatever the browser calls itself', () => {
    expect(shouldMixThroughWebAudio({ ios: true, safari: false })).toBe(true)
  })

  it('mixes in desktop Safari', () => {
    expect(shouldMixThroughWebAudio({ ios: false, safari: true })).toBe(true)
  })

  it('leaves Chrome and Firefox on the path that already works for them', () => {
    // Not a neutral change: element-per-track is simpler and lets the output
    // picker work normally. Only the browsers with the fault pay for it.
    expect(shouldMixThroughWebAudio({ ios: false, safari: false })).toBe(false)
  })
})

describe('the invariant that makes it safe', () => {
  /**
   * With the mix on, LiveKit switches output device by calling `setSinkId`
   * on the AudioContext and *throws* where that is missing. We only avoid
   * that because the mixed platforms are exactly the ones where we already
   * refuse to show an output picker. This holds us to it.
   */
  it('never mixes on a platform that also offers an output picker', () => {
    expect(mixConflictsWithOutputPicker({ ios: true, safari: true, canSelectOutput: false })).toBe(
      false
    )
    expect(mixConflictsWithOutputPicker({ ios: false, safari: false, canSelectOutput: true })).toBe(
      false
    )
  })

  it('says so loudly if that pairing ever comes apart', () => {
    // The regression this exists for: a future Safari exposes setSinkId on
    // media elements, `canSelectOutput` starts returning true, and the
    // speaker menu begins throwing for every iPhone on site.
    expect(mixConflictsWithOutputPicker({ ios: true, safari: true, canSelectOutput: true })).toBe(
      true
    )
  })
})
