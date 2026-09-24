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

describe('App Transport Security', () => {
  const ats = /<key>NSAppTransportSecurity<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(plist)?.[1]

  it('lets the app reach a plain-HTTP box by its address', () => {
    // A box without a certificate advertises its IP address, and since
    // iOS 17 plain HTTP to an IP address needs this key. Without it every
    // iPhone joining such a box sees one that is switched off.
    expect(ats, 'NSAppTransportSecurity is missing').toBeDefined()
    expect(ats).toMatch(/<key>NSAllowsLocalNetworking<\/key>\s*<true\/>/)
  })

  it.each(['NSAllowsArbitraryLoads', 'NSAllowsArbitraryLoadsInWebContent'])(
    'does not set %s',
    (key) => {
      // Each asks App Review for a justification. The first does nothing
      // beside NSAllowsLocalNetworking on iOS 10 and later; the second opens
      // plain HTTP to every name, a decision recorded in
      // native/ios/APP-STORE-CHECKLIST.md rather than a key to add quietly.
      expect(ats).not.toContain(`<key>${key}</key>`)
    }
  )
})

describe('the oldest iOS the app installs on', () => {
  const project = readFileSync(
    join(import.meta.dirname, '..', '..', 'native/ios/App/App.xcodeproj/project.pbxproj'),
    'utf8'
  )

  it('is 17 in every build configuration', () => {
    // The native work planned for the app leans on iOS 16.1 to 16.4 —
    // Live Activities, the web audio session, push-to-talk woken by local
    // push — and a floor that differs between Debug and Release is how a
    // feature tested on one build crashes the other.
    const targets = [...project.matchAll(/IPHONEOS_DEPLOYMENT_TARGET = ([\d.]+);/g)].map(
      (m) => m[1]
    )
    expect(targets.length).toBeGreaterThan(0)
    expect(new Set(targets)).toEqual(new Set(['17.0']))
  })

  it('is the one the Capacitor Swift package was last synced with', () => {
    // `cap sync` copies the project's floor into CapApp-SPM/Package.swift:
    // the major version of the first IPHONEOS_DEPLOYMENT_TARGET. Out of
    // step, the next sync rewrites the file as an unexplained change in
    // somebody else's diff, and a floor lowered without a sync stops the
    // build, because a package cannot ask for a newer iOS than the app that
    // links it.
    const swiftPackage = readFileSync(
      join(import.meta.dirname, '..', '..', 'native/ios/App/CapApp-SPM/Package.swift'),
      'utf8'
    )
    const floor = /IPHONEOS_DEPLOYMENT_TARGET = (\d+)/.exec(project)?.[1]
    expect(swiftPackage).toContain(`platforms: [.iOS(.v${floor})]`)
  })
})
