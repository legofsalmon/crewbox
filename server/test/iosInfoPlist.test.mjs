import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * What the iPhone app declares to iOS.
 *
 * iOS checks Info.plist at the moment of use, not at build time: an app that
 * opens the camera, or saves to Photos, without a purpose string for it is
 * terminated on the spot. Nothing in the build or the web tests notices, and
 * the web view reaches both on its own — the file picker's Take Photo, the
 * long-press Save to Photos — with no native code in this repo asking for
 * either. So the keys are pinned here, beside the Android permission check,
 * where a regenerated or hand-edited plist that drops one fails CI rather
 * than a crew member's app.
 */

const plist = readFileSync(
  join(import.meta.dirname, '..', '..', 'native/ios/App/App/Info.plist'),
  'utf8'
)
  // The comments explain keys by name; they must not count as the keys.
  .replace(/<!--[\s\S]*?-->/g, '')

/** The string value of a key, or undefined when the key is absent. */
function stringFor(key) {
  return new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(plist)?.[1]
}

describe('iPhone purpose strings', () => {
  it.each([
    // Take Photo or Video in the web view's file picker.
    'NSCameraUsageDescription',
    // Save to Photos from a long press on an image.
    'NSPhotoLibraryAddUsageDescription',
    // Talkback, and the sound on a video taken from the picker.
    'NSMicrophoneUsageDescription',
    // Reaching the box on the event Wi-Fi.
    'NSLocalNetworkUsageDescription',
  ])('declares %s in a sentence a crew member can read', (key) => {
    const text = stringFor(key)
    expect(text, `${key} is missing from Info.plist`).toBeTruthy()
    // iOS shows this in the permission prompt, and App Review turns away
    // strings that don't say what the access is for. A stub is as bad as
    // no string: the prompt reads as a demand with no reason attached.
    expect(text).toMatch(/^Crewbox .{20,}\.$/)
  })
})

describe('required device capabilities', () => {
  it('name the architecture the app is built for', () => {
    // Capacitor's template says armv7. The build is arm64 only, and an
    // upload whose list lacks arm64 has been refused by App Store Connect
    // (ITMS-90502) — a failure that surfaces at submission, not in CI.
    const list = /<key>UIRequiredDeviceCapabilities<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(
      plist
    )?.[1]
    const values = [...(list ?? '').matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1])
    expect(values).toContain('arm64')
    expect(values).not.toContain('armv7')
  })
})

describe('the oldest iOS the app installs on', () => {
  it('is 17 in every build configuration', () => {
    // The native work planned for the app leans on iOS 16.1 to 16.4 —
    // Live Activities, the web audio session, push-to-talk woken by local
    // push — and a floor that differs between Debug and Release is how a
    // feature tested on one build crashes the other. The Swift package in
    // CapApp-SPM says 15: that is the lowest the package supports, not what
    // the app targets, and the file belongs to the Capacitor CLI.
    const project = readFileSync(
      join(import.meta.dirname, '..', '..', 'native/ios/App/App.xcodeproj/project.pbxproj'),
      'utf8'
    )
    const targets = [...project.matchAll(/IPHONEOS_DEPLOYMENT_TARGET = ([\d.]+);/g)].map(
      (m) => m[1]
    )
    expect(targets.length).toBeGreaterThan(0)
    expect(new Set(targets)).toEqual(new Set(['17.0']))
  })
})
