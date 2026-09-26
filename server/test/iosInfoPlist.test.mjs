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
    // Scanning the join poster, and Take Photo or Video in the web view's
    // file picker.
    'NSCameraUsageDescription',
    // Save to Photos from a long press on an image.
    'NSPhotoLibraryAddUsageDescription',
    // Talkback, and the sound on a video taken from the picker.
    'NSMicrophoneUsageDescription',
    // Finding the box on the event Wi-Fi, and reaching it.
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

describe('finding boxes on the Wi-Fi', () => {
  it('lists the one Bonjour type the app looks for', () => {
    // Without it iOS fails the browser with NoAuth before the Local Network
    // alert is shown, so the join screen would say this phone could not look
    // for boxes, on every iPhone, with nothing in the build to say why. The
    // type is the one the box announces and DiscoveryPlugin.swift browses.
    const list = /<key>NSBonjourServices<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist)?.[1]
    const types = [...(list ?? '').matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1])
    expect(types).toEqual(['_crewbox._tcp'])
    const plugin = readFileSync(
      join(import.meta.dirname, '..', '..', 'native/ios/App/App/DiscoveryPlugin.swift'),
      'utf8'
    )
    expect(plugin).toContain('private static let serviceType = "_crewbox._tcp"')
  })

  it('registers the plugin on the bridge the storyboard starts', () => {
    // A plugin in the App target is not in Capacitor's own list of plugins,
    // which `cap sync` rewrites: the view controller registers it, and only
    // if the storyboard uses that view controller rather than Capacitor's.
    const storyboard = readFileSync(
      join(import.meta.dirname, '..', '..', 'native/ios/App/App/Base.lproj/Main.storyboard'),
      'utf8'
    )
    expect(storyboard).toContain('customClass="CrewboxViewController" customModule="App"')
    const controller = readFileSync(
      join(import.meta.dirname, '..', '..', 'native/ios/App/App/CrewboxViewController.swift'),
      'utf8'
    )
    expect(controller).toContain('bridge?.registerPluginInstance(DiscoveryPlugin())')
    // And both files are in the build, which a new file is not until the
    // project lists it.
    const project = readFileSync(
      join(import.meta.dirname, '..', '..', 'native/ios/App/App.xcodeproj/project.pbxproj'),
      'utf8'
    )
    for (const file of ['DiscoveryPlugin.swift', 'CrewboxViewController.swift']) {
      expect(project).toContain(`/* ${file} in Sources */,`)
    }
  })
})

describe('scanning the join poster', () => {
  it('registers the scanner beside the search, and builds it', () => {
    // Without it the join screen offers no scan, which reads as a feature
    // the iPhone app doesn't have rather than one that went missing.
    const controller = readFileSync(
      join(import.meta.dirname, '..', '..', 'native/ios/App/App/CrewboxViewController.swift'),
      'utf8'
    )
    expect(controller).toContain('bridge?.registerPluginInstance(ScannerPlugin())')
    const project = readFileSync(
      join(import.meta.dirname, '..', '..', 'native/ios/App/App.xcodeproj/project.pbxproj'),
      'utf8'
    )
    expect(project).toContain('/* ScannerPlugin.swift in Sources */,')
    // Under the name the page looks for (nativeScanner in web/src/lib/server.ts).
    const plugin = readFileSync(
      join(import.meta.dirname, '..', '..', 'native/ios/App/App/ScannerPlugin.swift'),
      'utf8'
    )
    expect(plugin).toContain('public let jsName = "CrewboxScanner"')
  })
})

describe('joining the Wi-Fi from its code', () => {
  const read = (path) => readFileSync(join(import.meta.dirname, '..', '..', path), 'utf8')

  it('registers the Wi-Fi join beside the scanner, and builds it', () => {
    expect(read('native/ios/App/App/CrewboxViewController.swift')).toContain(
      'bridge?.registerPluginInstance(WifiPlugin())'
    )
    expect(read('native/ios/App/App.xcodeproj/project.pbxproj')).toContain(
      '/* WifiPlugin.swift in Sources */,'
    )
    // Under the name the page looks for (nativeWifi in web/src/lib/server.ts).
    expect(read('native/ios/App/App/WifiPlugin.swift')).toContain(
      'public let jsName = "CrewboxWifi"'
    )
  })

  it('signs the app with the two entitlements the join needs, Time Sensitive, the App Group, and only those', () => {
    // Without Hotspot Configuration iOS refuses every network the app hands
    // it, and without Access Wi-Fi Information the check that the phone got
    // on the network always reads none, so every join would say it failed.
    // Time Sensitive lets a show stop through a Focus (Phase 4, docs/ALERTS.md).
    // Each is a capability of the App ID on the developer account as well.
    const entitlements = read('native/ios/App/App/App.entitlements').replace(/<!--[\s\S]*?-->/g, '')
    const keys = [...entitlements.matchAll(/<key>([^<]+)<\/key>\s*<true\/>/g)].map((m) => m[1])
    expect(keys.sort()).toEqual([
      'com.apple.developer.networking.HotspotConfiguration',
      'com.apple.developer.networking.wifi-info',
      'com.apple.developer.usernotifications.time-sensitive',
    ])
    // The App Group the Local Push provider shares, for the sign-ins
    // (appSignIns.test.mjs). A name on phones, chosen once.
    const groups =
      /<key>com\.apple\.security\.application-groups<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(
        entitlements
      )?.[1]
    expect([...(groups ?? '').matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1])).toEqual([
      'group.com.colmhewson.crewbox',
    ])
    expect([...entitlements.matchAll(/<key>/g)]).toHaveLength(4)
    // In every configuration of the app's target, which is the one with the
    // app's bundle identifier: a build without them installs, and joins
    // nothing.
    const configurations = [
      ...read('native/ios/App/App.xcodeproj/project.pbxproj').matchAll(
        /buildSettings = \{([^}]*PRODUCT_BUNDLE_IDENTIFIER = com\.colmhewson\.crewbox;[^}]*)\}/g
      ),
    ]
    expect(configurations).toHaveLength(2)
    for (const [, settings] of configurations) {
      expect(settings).toContain('CODE_SIGN_ENTITLEMENTS = App/App.entitlements;')
    }
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

describe('the stage countdown on the lock screen', () => {
  const read = (path) => readFileSync(join(import.meta.dirname, '..', '..', path), 'utf8')
  const project = read('native/ios/App/App.xcodeproj/project.pbxproj')

  it('declares Live Activities, or ActivityKit refuses every request', () => {
    expect(plist).toMatch(/<key>NSSupportsLiveActivities<\/key>\s*<true\/>/)
  })

  it('builds the Countdown extension as a widget extension, embedded in the app', () => {
    const extension = read('native/ios/App/Countdown/Info.plist')
    expect(extension).toMatch(
      /<key>NSExtensionPointIdentifier<\/key>\s*<string>com\.apple\.widgetkit-extension<\/string>/
    )
    expect(project).toContain('productType = "com.apple.product-type.app-extension";')
    expect(project).toContain('/* Countdown.appex in Embed Foundation Extensions */,')
    expect(project).toMatch(
      /dependencies = \(\s*\w+ \/\* PBXTargetDependency \*\/,\s*\);\s*name = App;/
    )
    // Its bundle id goes to App Store Connect with the app's, under it, as
    // the Local Push provider's does.
    const ids = [...project.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/g)].map((m) => m[1])
    expect([...new Set(ids)].sort()).toEqual([
      'com.colmhewson.crewbox',
      'com.colmhewson.crewbox.alerts',
      'com.colmhewson.crewbox.countdown',
    ])
  })

  it('shares one attributes type between the app and the extension', () => {
    // ActivityKit matches the app's activity to the extension's drawing by
    // this type, so both targets compile the same file.
    const builds = project.match(/\/\* CountdownAttributes\.swift in Sources \*\/,/g) ?? []
    expect(builds).toHaveLength(2)
    expect(project).toContain('/* CountdownWidget.swift in Sources */,')
    expect(project).toContain('/* LiveCountdown.swift in Sources */,')
    expect(read('native/ios/App/Countdown/CountdownWidget.swift')).toContain(
      'ActivityConfiguration(for: CountdownAttributes.self)'
    )
  })

  it('keeps the extension’s version with the app’s, as App Store Connect requires', () => {
    const versions = new Set(
      [...project.matchAll(/MARKETING_VERSION = ([^;]+);/g)].map((m) => m[1])
    )
    const builds = new Set(
      [...project.matchAll(/CURRENT_PROJECT_VERSION = ([^;]+);/g)].map((m) => m[1])
    )
    expect(versions.size).toBe(1)
    expect(builds.size).toBe(1)
  })
})

describe('the Local Push provider', () => {
  const read = (path) => readFileSync(join(import.meta.dirname, '..', '..', path), 'utf8')
  const project = read('native/ios/App/App.xcodeproj/project.pbxproj')
  const provider = read('native/ios/App/Alerts/Info.plist')

  it('is an app-push extension whose principal class is the provider', () => {
    expect(provider).toMatch(
      /<key>NSExtensionPointIdentifier<\/key>\s*<string>com\.apple\.networkextension\.app-push<\/string>/
    )
    expect(provider).toMatch(
      /<key>NSExtensionPrincipalClass<\/key>\s*<string>\$\(PRODUCT_MODULE_NAME\)\.AlertsProvider<\/string>/
    )
    expect(read('native/ios/App/Alerts/AlertsProvider.swift')).toContain(
      'final class AlertsProvider: NEAppPushProvider {'
    )
  })

  it('has the bundle id the app’s managers name, a name that reaches phones', () => {
    expect(project).toContain('PRODUCT_BUNDLE_IDENTIFIER = com.colmhewson.crewbox.alerts;')
    expect(read('native/ios/App/App/AlertsBoxes.swift')).toContain(
      'static let providerBundleId = "com.colmhewson.crewbox.alerts"'
    )
  })

  it('reads the sign-ins from the App Group the app keeps them in', () => {
    const shared = read('native/ios/App/App/AlertsBoxes.swift')
    const sessions = read('native/ios/App/App/SessionsPlugin.swift')
    const group = /static let appGroup = "([^"]+)"/.exec(sessions)?.[1]
    const service = /static let service = "([^"]+)"/.exec(sessions)?.[1]
    expect(shared).toContain(`static let appGroup = "${group}"`)
    expect(shared).toContain(`static let sessionsService = "${service}"`)
    const entitlements = read('native/ios/App/Alerts/Alerts.entitlements')
    expect(entitlements).toContain(`<string>${group}</string>`)
    expect(entitlements).toContain('<string>app-push-provider</string>')
  })

  it('checks the box before it sends a sign-in', () => {
    // The provider starts on any Wi-Fi with the registered name.
    const link = read('native/ios/App/Alerts/BoxLink.swift')
    const check = link.indexOf('BoxProof.check(')
    const token = link.indexOf('SignIn.token(named: box.session)')
    const hello = link.indexOf('"type": "hello"')
    expect(check).toBeGreaterThan(-1)
    expect(token).toBeGreaterThan(check)
    expect(hello).toBeGreaterThan(token)
    expect(link).toMatch(/guard verdict == \.proven \|\| verdict == \.sameEvent/)
  })

  it('is left out of the app until Apple grants Local Push, and built on its own in CI', () => {
    // Embedding it before then fails the signed archive, since the App ID
    // can't have the capability.
    expect(project).not.toContain('Alerts.appex in Embed Foundation Extensions')
    expect(read('native/ios/App/App/App.entitlements')).not.toContain('app-push-provider')
    expect(read('.github/workflows/native.yml')).toMatch(/-target Alerts -sdk iphoneos/)
  })
})
